/**
 * Runner script executed by the iterate-from-review GitHub Actions workflow.
 */

import { runClaudeSession } from "../claude/session.js";
import { pickModel } from "../claude/complexity.js";
import { buildPrContext } from "../github/context.js";
import { logger } from "../utils/logger.js";

const {
  PR_NUMBER = "",
  PR_TITLE = "",
  COMMENT_BODY = "",
  COMMENT_AUTHOR = "",
  GITHUB_REPOSITORY = "",
} = process.env;

if (!PR_NUMBER || !GITHUB_REPOSITORY) {
  logger.error("Missing required environment variables: PR_NUMBER, GITHUB_REPOSITORY");
  process.exit(1);
}

// Build full PR context: linked issue → PR description → review history → conversation
const prContext = buildPrContext(GITHUB_REPOSITORY, PR_NUMBER);

// COMMENT_BODY is the triggering event (may be empty if review had no summary text).
// The inline comments are already captured in prContext via the reviews API.
// We only fail if there is genuinely no feedback at all.
if (!COMMENT_BODY && !prContext) {
  logger.error("No review feedback found");
  process.exit(1);
}

const model = await pickModel(`PR review feedback:\n${COMMENT_BODY}\n\n${prContext.slice(0, 1000)}`);

const result = await runClaudeSession(
  "iterate-review",
  {
    PR_NUMBER,
    PR_TITLE,
    REPO_FULL_NAME: GITHUB_REPOSITORY,
    COMMENT_AUTHOR,
    COMMENT_BODY: COMMENT_BODY || "(see inline comments in history below)",
    PR_CONTEXT: prContext,
    SF_TARGET_ORG: "pipeline-org",
  },
  model
);

if (result.success) {
  logger.info({ pr: PR_NUMBER }, "PR updated with review feedback");
  process.exit(0);
} else {
  logger.error({ summary: result.summary }, "Claude session failed");
  process.exit(1);
}
