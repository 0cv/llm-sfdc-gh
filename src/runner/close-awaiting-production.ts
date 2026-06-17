/**
 * Runner script executed by the close-awaiting-production GitHub Actions workflow.
 * Closes awaiting-production tracking issues once their merge commit reaches production.
 */

import { compareCommitToBranch } from "../github/pulls.js";
import {
  actionsRunUrl,
  closeIssue,
  listOpenIssuesByLabel,
  postIssueComment,
} from "../github/issues.js";
import { logger } from "../utils/logger.js";
import { requireEnv } from "./base.js";

const AWAITING_PRODUCTION_LABEL = "claude-awaiting-production";
const MERGE_COMMIT_PATTERN = /Merge commit:\s*`([0-9a-f]{40})`/i;

requireEnv("GITHUB_REPOSITORY", "PRODUCTION_BRANCH");

const { GITHUB_REPOSITORY = "", PRODUCTION_BRANCH = "" } = process.env;

const runUrl = actionsRunUrl();
const issues = await listOpenIssuesByLabel(GITHUB_REPOSITORY, AWAITING_PRODUCTION_LABEL);
let closedCount = 0;
let skippedCount = 0;

for (const issue of issues) {
  const mergeCommit = parseMergeCommit(issue.body ?? "");
  if (!mergeCommit) {
    skippedCount += 1;
    logger.warn(
      { issue: issue.number, title: issue.title },
      "Skipping awaiting-production issue without a parseable merge commit"
    );
    continue;
  }

  const status = await compareCommitToBranch(GITHUB_REPOSITORY, mergeCommit, PRODUCTION_BRANCH);
  if (!status.contains) {
    skippedCount += 1;
    logger.info(
      {
        issue: issue.number,
        mergeCommit,
        productionBranch: PRODUCTION_BRANCH,
        status: status.status,
        aheadBy: status.aheadBy,
        behindBy: status.behindBy,
      },
      "Awaiting-production issue is still not in production"
    );
    continue;
  }

  const comment = [
    `Closing this tracking issue because merge commit \`${mergeCommit}\` is now contained in production branch \`${PRODUCTION_BRANCH}\`.`,
    runUrl ? `Workflow run: ${runUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  await postIssueComment(GITHUB_REPOSITORY, String(issue.number), comment);
  const closed = await closeIssue(GITHUB_REPOSITORY, String(issue.number), "completed");

  if (closed) {
    closedCount += 1;
    logger.info(
      { issue: issue.number, mergeCommit, productionBranch: PRODUCTION_BRANCH },
      "Closed awaiting-production issue"
    );
  } else {
    skippedCount += 1;
  }
}

logger.info(
  { repo: GITHUB_REPOSITORY, productionBranch: PRODUCTION_BRANCH, closedCount, skippedCount },
  "Awaiting-production cleanup complete"
);

function parseMergeCommit(body: string): string | null {
  return body.match(MERGE_COMMIT_PATTERN)?.[1] ?? null;
}
