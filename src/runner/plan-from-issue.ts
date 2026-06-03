/**
 * Runner script executed by the plan-from-issue GitHub Actions workflow.
 */

import { runClaudeSession } from "../claude/session.js";
import { pickModel } from "../claude/complexity.js";
import { postIssueComment } from "../github/issues.js";
import { requireEnv } from "./base.js";
import { logger } from "../utils/logger.js";

requireEnv("ISSUE_NUMBER", "ISSUE_TITLE", "ISSUE_AUTHOR", "GITHUB_REPOSITORY");

const {
  ISSUE_NUMBER = "",
  ISSUE_TITLE = "",
  ISSUE_BODY = "",
  ISSUE_AUTHOR = "",
  GITHUB_REPOSITORY = "",
} = process.env;

const model = await pickModel(`Plan GitHub issue: ${ISSUE_TITLE}\n\n${ISSUE_BODY}`);

const result = await runClaudeSession(
  "plan-issue",
  {
    ISSUE_NUMBER,
    ISSUE_TITLE,
    ISSUE_BODY,
    ISSUE_AUTHOR,
    REPO_FULL_NAME: GITHUB_REPOSITORY,
  },
  model,
  {
    allowedTools: ["Read", "Glob", "Grep"],
    maxTurns: parseInt(process.env.MAX_PLAN_TURNS || "15"),
    summaryMaxChars: 12000,
  }
);

if (result.success) {
  const plan = result.summary.trim();
  await postIssueComment(
    GITHUB_REPOSITORY,
    ISSUE_NUMBER,
    plan.startsWith("## Plan") ? plan : `## Plan\n\n${plan}`
  );
  logger.info({ issue: ISSUE_NUMBER }, "Plan posted on issue");
  process.exit(0);
}

await postIssueComment(
  GITHUB_REPOSITORY,
  ISSUE_NUMBER,
  `Planning failed.\n\n${result.summary.slice(0, 1000)}`
);
logger.error({ summary: result.summary }, "Plan session failed");
process.exit(1);
