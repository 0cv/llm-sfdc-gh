/**
 * Dispatches a repository_dispatch event to GitHub, triggering a workflow.
 */

import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import type { SalesforceError } from "../email/parser.js";
import {
  compareCommitToBranch,
  findLatestMergedPullRequestByTitle,
  findOpenPullRequestByTitle,
  type BranchContainment,
  type MergedPullRequestMatch,
} from "./pulls.js";
import { addIssueLabels, createIssue, findOpenIssueByTitle, updateIssueBody } from "./issues.js";
import { pipelineConfigForRepo, type RepoPipelineConfig } from "./pipeline.js";
import { githubTokenForRepo } from "./token.js";

const recentDispatches = new Map<string, number>();
const AWAITING_PRODUCTION_LABEL = "claude-awaiting-production";

export function fixPullRequestTitle(error: SalesforceError): string {
  return `fix: ${error.exceptionType} in ${error.apexClass ?? error.triggerName ?? "Unknown"}`;
}

function reserveDispatch(targetRepo: string, prTitle: string): boolean {
  const now = Date.now();
  const ttlMs = config.dedupTtlHours * 60 * 60 * 1000;

  for (const [key, ts] of recentDispatches) {
    if (now - ts > ttlMs) recentDispatches.delete(key);
  }

  const key = `${targetRepo}\n${prTitle.trim()}`;
  if (recentDispatches.has(key)) return false;

  recentDispatches.set(key, now);
  return true;
}

function releaseDispatch(targetRepo: string, prTitle: string): void {
  recentDispatches.delete(`${targetRepo}\n${prTitle.trim()}`);
}

export async function dispatchSalesforceError(
  error: SalesforceError,
  targetRepo: string
): Promise<void> {
  const prTitle = fixPullRequestTitle(error);

  if (!reserveDispatch(targetRepo, prTitle)) {
    logger.info(
      { targetRepo, title: prTitle },
      "Dispatch already reserved recently for this PR title, skipping"
    );
    return;
  }

  try {
    const existingPr = await findOpenPullRequestByTitle(targetRepo, prTitle);
    if (existingPr) {
      logger.info(
        { targetRepo, title: prTitle, pr: existingPr.url },
        "Open PR already exists for this error, skipping dispatch"
      );
      return;
    }

    const awaitingProduction = await suppressIfMergedFixAwaitsProduction(
      error,
      targetRepo,
      prTitle
    );
    if (awaitingProduction) return;

    const token = githubTokenForRepo(targetRepo);
    if (!token) {
      throw new Error(`No GitHub token configured for ${targetRepo}`);
    }

    const response = await fetch(`https://api.github.com/repos/${targetRepo}/dispatches`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        event_type: "salesforce-error",
        client_payload: {
          subject: error.subject,
          orgName: error.orgName,
          exceptionType: error.exceptionType,
          errorMessage: error.message,
          apexClass: error.apexClass ?? "",
          triggerName: error.triggerName ?? "",
          triggerOperation: error.triggerOperation ?? "",
          lineNumber: String(error.lineNumber ?? ""),
          stackTrace: error.stackTrace,
          rawBody: error.rawBody,
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub dispatch failed: ${response.status} ${body}`);
    }

    logger.info(
      { targetRepo, exceptionType: error.exceptionType, prTitle },
      "Dispatched to GitHub Actions"
    );
  } catch (err) {
    releaseDispatch(targetRepo, prTitle);
    throw err;
  }
}

async function suppressIfMergedFixAwaitsProduction(
  error: SalesforceError,
  targetRepo: string,
  prTitle: string
): Promise<boolean> {
  const pipeline = pipelineConfigForRepo(targetRepo);
  if (!pipeline) return false;

  try {
    const mergedPr = await findLatestMergedPullRequestByTitle(targetRepo, prTitle);
    if (!mergedPr) return false;

    const statuses = await pipelineStatuses(targetRepo, mergedPr, pipeline);
    const productionStatus = statuses.find((status) => status.branch === pipeline.productionBranch);

    if (productionStatus?.contains) {
      logger.info(
        {
          targetRepo,
          title: prTitle,
          pr: mergedPr.url,
          productionBranch: pipeline.productionBranch,
        },
        "Matching merged PR is already in production; allowing new dispatch"
      );
      return false;
    }

    const preProductionHits = statuses.filter(
      (status) => status.branch !== pipeline.productionBranch && status.contains
    );
    if (preProductionHits.length === 0) {
      logger.info(
        {
          targetRepo,
          title: prTitle,
          pr: mergedPr.url,
          productionBranch: pipeline.productionBranch,
          branches: statuses.map((status) => ({
            branch: status.branch,
            contains: status.contains,
            status: status.status,
          })),
        },
        "Matching merged PR is not present in configured pre-production branches; allowing dispatch"
      );
      return false;
    }

    await upsertAwaitingProductionIssue(targetRepo, prTitle, error, mergedPr, pipeline, statuses);
    logger.info(
      {
        targetRepo,
        title: prTitle,
        pr: mergedPr.url,
        productionBranch: pipeline.productionBranch,
        preProductionBranches: preProductionHits.map((status) => status.branch),
      },
      "Merged fix PR is awaiting production; skipping dispatch"
    );
    return true;
  } catch (err) {
    logger.warn(
      { err, targetRepo, title: prTitle },
      "Failed to evaluate pipeline-aware duplicate status; allowing dispatch"
    );
    return false;
  }
}

async function pipelineStatuses(
  targetRepo: string,
  mergedPr: MergedPullRequestMatch,
  pipeline: RepoPipelineConfig
): Promise<BranchContainment[]> {
  const branches = [...new Set([...pipeline.preProductionBranches, pipeline.productionBranch])];
  return Promise.all(
    branches.map((branch) => compareCommitToBranch(targetRepo, mergedPr.mergeCommitSha, branch))
  );
}

async function upsertAwaitingProductionIssue(
  targetRepo: string,
  prTitle: string,
  error: SalesforceError,
  mergedPr: MergedPullRequestMatch,
  pipeline: RepoPipelineConfig,
  statuses: BranchContainment[]
): Promise<void> {
  const issueTitle = `Awaiting production: ${prTitle}`;
  const body = formatAwaitingProductionIssueBody(error, mergedPr, pipeline, statuses);

  try {
    const existingIssue = await findOpenIssueByTitle(targetRepo, issueTitle);
    const issue = existingIssue ?? (await createIssue(targetRepo, issueTitle, body));

    if (existingIssue) {
      await updateIssueBody(targetRepo, String(existingIssue.number), body);
    }

    if (issue) {
      await addIssueLabels(targetRepo, String(issue.number), [AWAITING_PRODUCTION_LABEL]);
      logger.info(
        { targetRepo, issue: issue.url, pr: mergedPr.url },
        "Awaiting-production tracking issue is ready"
      );
    }
  } catch (err) {
    logger.warn(
      { err, targetRepo, title: issueTitle, pr: mergedPr.url },
      "Failed to create or update awaiting-production tracking issue"
    );
  }
}

function formatAwaitingProductionIssueBody(
  error: SalesforceError,
  mergedPr: MergedPullRequestMatch,
  pipeline: RepoPipelineConfig,
  statuses: BranchContainment[]
): string {
  const statusLines = statuses.map((status) => {
    const placement = status.contains ? "contains merge commit" : "does not contain merge commit";
    return `- \`${status.branch}\`: ${placement} (${status.status}, ahead ${status.aheadBy}, behind ${status.behindBy})`;
  });
  const rootCause = error.apexClass ?? error.triggerName ?? "Unknown";
  const entryPoint =
    error.triggerName && error.triggerOperation
      ? `${error.triggerName} (${error.triggerOperation})`
      : (error.triggerName ?? "Unknown");

  return [
    "A repeat production Salesforce error matched a fix PR that has already been merged, but the merge commit is not on the configured production branch yet.",
    "",
    "## Matching Fix PR",
    `- PR: [#${mergedPr.number}](${mergedPr.url})`,
    `- Title: ${mergedPr.title}`,
    `- Merged at: ${mergedPr.mergedAt}`,
    `- Merge commit: \`${mergedPr.mergeCommitSha}\``,
    `- Original base branch: \`${mergedPr.baseBranch || "unknown"}\``,
    "",
    "## Pipeline Status",
    `- Production branch: \`${pipeline.productionBranch}\``,
    ...statusLines,
    "",
    "## Latest Error Summary",
    `- Last seen: ${new Date().toISOString()}`,
    `- Org: ${error.orgName || "Unknown"}`,
    `- Exception: ${error.exceptionType}`,
    `- Root cause: ${rootCause}${error.lineNumber ? ` line ${error.lineNumber}` : ""}`,
    `- Entry point: ${entryPoint}`,
    `- Message: ${truncate(error.message, 1000) || "Unknown"}`,
    "",
    "This issue tracks the production promotion gap. No new fix PR was created for this repeat error.",
  ].join("\n");
}

function truncate(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 3)}...`;
}
