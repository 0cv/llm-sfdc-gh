/**
 * Runner script executed by the fix-from-error GitHub Actions workflow.
 * Reads error details from environment variables and runs a Claude Agent SDK session.
 */

import { runClaudeSession } from "../claude/session.js";
import { logger } from "../utils/logger.js";

const {
  EXCEPTION_TYPE = "",
  ERROR_MESSAGE = "",
  APEX_CLASS = "",
  LINE_NUMBER = "",
  STACK_TRACE = "",
  RAW_BODY = "",
} = process.env;

if (!EXCEPTION_TYPE || !APEX_CLASS) {
  logger.error("Missing required environment variables: EXCEPTION_TYPE, APEX_CLASS");
  process.exit(1);
}

const result = await runClaudeSession("fix-error", {
  EXCEPTION_TYPE,
  ERROR_MESSAGE,
  APEX_CLASS,
  LINE_NUMBER,
  STACK_TRACE,
  RAW_EMAIL: RAW_BODY,
  SF_TARGET_ORG: "pipeline-org",
});

if (result.success && result.prUrl) {
  logger.info({ prUrl: result.prUrl }, "PR created successfully");
  process.exit(0);
} else if (result.success) {
  logger.warn({ summary: result.summary }, "Claude completed but no PR URL found");
  process.exit(1);
} else {
  logger.error({ summary: result.summary }, "Claude session failed");
  process.exit(1);
}
