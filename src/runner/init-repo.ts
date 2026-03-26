/**
 * Runner script for the init-repo workflow.
 * Analyses the SF repo + org and writes a CLAUDE.md with project conventions.
 */

import { runClaudeSession } from "../claude/session.js";
import { logger } from "../utils/logger.js";

const { GITHUB_REPOSITORY = "" } = process.env;

const result = await runClaudeSession("init", {
  SF_TARGET_ORG: "pipeline-org",
  REPO_FULL_NAME: GITHUB_REPOSITORY,
});

if (result.success) {
  logger.info("CLAUDE.md written and committed");
  process.exit(0);
} else {
  logger.error({ summary: result.summary }, "Init failed");
  process.exit(1);
}
