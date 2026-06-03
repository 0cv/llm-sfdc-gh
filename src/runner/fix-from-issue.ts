/**
 * Runner script executed by the fix-from-issue GitHub Actions workflow.
 */

import { appendFile } from "node:fs/promises";
import { runClaudeSession } from "../claude/session.js";
import { pickModel } from "../claude/complexity.js";
import { requireEnv } from "./base.js";
import { logger } from "../utils/logger.js";
import { addIssueLabels, postIssueComment, removeIssueLabel } from "../github/issues.js";

requireEnv("ISSUE_NUMBER", "ISSUE_TITLE", "ISSUE_AUTHOR");

const { ISSUE_NUMBER = "", ISSUE_TITLE = "", ISSUE_BODY = "", ISSUE_AUTHOR = "" } = process.env;
const REPO_FULL_NAME = process.env.GITHUB_REPOSITORY ?? "";

async function setOutcome(
  outcome: "pr_created" | "clarification_requested" | "failed"
): Promise<void> {
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `outcome=${outcome}\n`);
  }
}

const model = await pickModel(`Fix GitHub issue: ${ISSUE_TITLE}\n\n${ISSUE_BODY}`);

const result = await runClaudeSession(
  "fix-issue",
  {
    ISSUE_NUMBER,
    ISSUE_TITLE,
    ISSUE_BODY,
    ISSUE_AUTHOR,
    REPO_FULL_NAME,
    SF_TARGET_ORG: "pipeline-org",
  },
  model
);

if (result.success && result.prUrl) {
  const prNumber = result.prUrl.match(/\/pull\/(\d+)/)?.[1];
  const prRef = prNumber ? `#${prNumber} (${result.prUrl})` : result.prUrl;

  await removeIssueLabel(REPO_FULL_NAME, ISSUE_NUMBER, "claude-fix-in-progress");
  await removeIssueLabel(REPO_FULL_NAME, ISSUE_NUMBER, "claude-fix-failed");
  await removeIssueLabel(REPO_FULL_NAME, ISSUE_NUMBER, "claude-fix-needs-info");
  await addIssueLabels(REPO_FULL_NAME, ISSUE_NUMBER, ["claude-fix-ready"]);
  await postIssueComment(
    REPO_FULL_NAME,
    ISSUE_NUMBER,
    `Fix PR opened: ${prRef}\n\nFurther comments on this issue will be applied to that PR while it is open.`
  );

  await setOutcome("pr_created");
  logger.info({ prUrl: result.prUrl, issue: ISSUE_NUMBER }, "PR created from issue");
  process.exit(0);
} else if (result.success && result.summary.includes("CLARIFICATION_REQUESTED")) {
  await removeIssueLabel(REPO_FULL_NAME, ISSUE_NUMBER, "claude-fix-in-progress");
  await removeIssueLabel(REPO_FULL_NAME, ISSUE_NUMBER, "claude-fix-ready");
  await removeIssueLabel(REPO_FULL_NAME, ISSUE_NUMBER, "claude-fix-failed");
  await addIssueLabels(REPO_FULL_NAME, ISSUE_NUMBER, ["claude-fix-needs-info"]);

  await setOutcome("clarification_requested");
  logger.info({ issue: ISSUE_NUMBER }, "Clarification requested on issue");
  process.exit(0);
} else {
  await removeIssueLabel(REPO_FULL_NAME, ISSUE_NUMBER, "claude-fix-in-progress");
  await addIssueLabels(REPO_FULL_NAME, ISSUE_NUMBER, ["claude-fix-failed"]);

  await setOutcome("failed");
  logger.error({ summary: result.summary }, "Claude session failed");
  process.exit(1);
}
