/**
 * Lightweight triage using Claude Haiku to determine if an error
 * is a code bug (worth fixing) vs. operational noise (skip).
 */

import Anthropic from "@anthropic-ai/sdk";
import type { SalesforceError } from "../email/parser.js";
import { logger } from "../utils/logger.js";

export interface TriageResult {
  isCodeBug: boolean;
  confidence: "high" | "medium" | "low";
  reason: string;
}

const TRIAGE_PROMPT = `You are a Salesforce error triage system. Classify the following exception as either a CODE_BUG (requires a code fix) or OPERATIONAL (transient/environmental, no code fix needed).

Examples of OPERATIONAL (skip these):
- Governor limit exceeded due to bulk data load
- UNABLE_TO_LOCK_ROW (lock contention)
- External service timeout / callout failures
- License limit errors
- Concurrent request limit

Examples of CODE_BUG (fix these):
- NullPointerException in custom Apex
- SOQL query errors in custom code
- Type errors, missing field references
- Logic errors causing DML failures
- Unhandled exceptions in triggers/classes

Respond in JSON format only:
{"isCodeBug": true/false, "confidence": "high/medium/low", "reason": "brief explanation"}`;

export async function triageError(
  error: SalesforceError
): Promise<TriageResult> {
  // Skip triage if no API key configured (local dev with claude.ai login)
  if (!process.env.ANTHROPIC_API_KEY) {
    logger.info("No ANTHROPIC_API_KEY — skipping triage, assuming code bug");
    return { isCodeBug: true, confidence: "low", reason: "Triage skipped (no API key)" };
  }

  try {
    const anthropic = new Anthropic();
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content: `${TRIAGE_PROMPT}\n\nException type: ${error.exceptionType}\nMessage: ${error.message}\nClass: ${error.apexClass ?? "unknown"}\nStack trace:\n${error.stackTrace}`,
        },
      ],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";
    const result = JSON.parse(text) as TriageResult;

    logger.info(
      { isCodeBug: result.isCodeBug, confidence: result.confidence, reason: result.reason },
      "Triage result"
    );

    return result;
  } catch (err) {
    logger.error(err, "Triage failed, defaulting to code bug");
    return { isCodeBug: true, confidence: "low", reason: "Triage failed" };
  }
}
