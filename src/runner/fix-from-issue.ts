/**
 * Runner script executed by the fix-from-issue GitHub Actions workflow.
 */

import { runClaudeSession } from "../claude/session.js";
import { pickModel } from "../claude/complexity.js";
import { requireEnv } from "./base.js";
import { logger } from "../utils/logger.js";
import { actionsRunUrl, postIssueComment } from "../github/issues.js";

requireEnv("ISSUE_NUMBER", "ISSUE_TITLE");

const { ISSUE_NUMBER = "", ISSUE_TITLE = "", ISSUE_BODY = "" } = process.env;
const REPO_FULL_NAME = process.env.GITHUB_REPOSITORY ?? "";

const runUrl = actionsRunUrl();
await postIssueComment(
  REPO_FULL_NAME,
  ISSUE_NUMBER,
  runUrl ? `Fix workflow started: [Actions run](${runUrl}).` : "Fix workflow started."
);

const model = await pickModel(`Fix GitHub issue: ${ISSUE_TITLE}\n\n${ISSUE_BODY}`);

const result = await runClaudeSession(
  "fix-issue",
  {
    ISSUE_NUMBER,
    ISSUE_TITLE,
    ISSUE_BODY,
    REPO_FULL_NAME,
    SF_TARGET_ORG: "pipeline-org",
  },
  model
);

if (result.success && result.prUrl) {
  const prNumber = result.prUrl.match(/\/pull\/(\d+)/)?.[1];
  const prRef = prNumber ? `#${prNumber} (${result.prUrl})` : result.prUrl;

  await postIssueComment(
    REPO_FULL_NAME,
    ISSUE_NUMBER,
    `Fix PR opened: ${prRef}\n\nFurther comments on this issue will be applied to that PR while it is open.`
  );

  logger.info({ prUrl: result.prUrl, issue: ISSUE_NUMBER }, "PR created from issue");
  process.exit(0);
} else {
  logger.error({ summary: result.summary }, "Claude session failed");
  process.exit(1);
}
