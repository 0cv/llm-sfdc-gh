/**
 * Runner script executed by the iterate-from-review GitHub Actions workflow.
 */

import { runClaudeSession } from "../claude/session.js";
import { logger } from "../utils/logger.js";

const { PR_NUMBER = "", PR_TITLE = "", COMMENT_BODY = "", COMMENT_AUTHOR = "" } = process.env;

if (!PR_NUMBER || !COMMENT_BODY) {
  logger.error("Missing required environment variables: PR_NUMBER, COMMENT_BODY");
  process.exit(1);
}

const result = await runClaudeSession("iterate-review", {
  PR_NUMBER,
  PR_TITLE,
  REPO_FULL_NAME: process.env.GITHUB_REPOSITORY ?? "",
  COMMENT_BODY,
  COMMENT_AUTHOR,
  COMMENT_TYPE: "review",
  SF_TARGET_ORG: "pipeline-org",
});

if (result.success) {
  logger.info({ pr: PR_NUMBER }, "PR updated with review feedback");
  process.exit(0);
} else {
  logger.error({ summary: result.summary }, "Claude session failed");
  process.exit(1);
}
