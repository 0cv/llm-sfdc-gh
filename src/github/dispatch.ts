/**
 * Dispatches a repository_dispatch event to GitHub, triggering a workflow.
 */

import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import type { SalesforceError } from "../email/parser.js";
import { findOpenPullRequestByTitle } from "./pulls.js";
import { githubTokenForRepo } from "./token.js";

const recentDispatches = new Map<string, number>();

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
