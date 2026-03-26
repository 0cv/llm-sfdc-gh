/**
 * Runner script executed by the fix-from-error GitHub Actions workflow.
 * Reads error details from environment variables and runs a Claude Agent SDK session.
 */

import { runClaudeSession } from "../claude/session.js";
import { pickModel } from "../claude/complexity.js";
import { requireEnv } from "./base.js";
import { logger } from "../utils/logger.js";

requireEnv("EXCEPTION_TYPE", "APEX_CLASS");

const {
  EMAIL_SUBJECT = "",
  ORG_NAME = "",
  EXCEPTION_TYPE = "",
  ERROR_MESSAGE = "",
  APEX_CLASS = "",
  TRIGGER_NAME = "",
  TRIGGER_OPERATION = "",
  LINE_NUMBER = "",
  STACK_TRACE = "",
  RAW_BODY = "",
} = process.env;

const model = await pickModel(
  `Fix Salesforce error: ${EXCEPTION_TYPE} in ${APEX_CLASS} line ${LINE_NUMBER}\n${ERROR_MESSAGE}\n${STACK_TRACE}`
);

const result = await runClaudeSession(
  "fix-error",
  {
    EMAIL_SUBJECT,
    ORG_NAME,
    EXCEPTION_TYPE,
    ERROR_MESSAGE,
    APEX_CLASS,
    TRIGGER_NAME,
    TRIGGER_OPERATION,
    LINE_NUMBER,
    STACK_TRACE,
    RAW_BODY,
    SF_TARGET_ORG: "pipeline-org",
  },
  model
);

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
