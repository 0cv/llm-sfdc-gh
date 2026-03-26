/**
 * Runner script executed by the fix-from-issue GitHub Actions workflow.
 */

import { runClaudeSession } from "../claude/session.js";
import { pickModel } from "../claude/complexity.js";
import { logger } from "../utils/logger.js";

const { ISSUE_NUMBER = "", ISSUE_TITLE = "", ISSUE_BODY = "" } = process.env;

if (!ISSUE_NUMBER || !ISSUE_TITLE) {
  logger.error("Missing required environment variables: ISSUE_NUMBER, ISSUE_TITLE");
  process.exit(1);
}

const model = await pickModel(`Fix GitHub issue: ${ISSUE_TITLE}\n\n${ISSUE_BODY}`);

const result = await runClaudeSession(
  "fix-issue",
  {
    ISSUE_NUMBER,
    ISSUE_TITLE,
    ISSUE_BODY,
    REPO_FULL_NAME: process.env.GITHUB_REPOSITORY ?? "",
    SF_TARGET_ORG: "pipeline-org",
  },
  model
);

if (result.success && result.prUrl) {
  logger.info({ prUrl: result.prUrl, issue: ISSUE_NUMBER }, "PR created from issue");
  process.exit(0);
} else {
  logger.error({ summary: result.summary }, "Claude session failed");
  process.exit(1);
}
