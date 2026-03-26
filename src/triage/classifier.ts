/**
 * Lightweight triage using Claude Haiku to determine if an error
 * is a code bug (worth fixing) vs. operational noise (skip).
 *
 * Uses query() (agent SDK / claude CLI) so CLAUDE_CODE_OAUTH_TOKEN is handled correctly.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SalesforceError } from "../email/parser.js";
import { logger } from "../utils/logger.js";

export interface TriageResult {
  isCodeBug: boolean;
  confidence: "high" | "medium" | "low";
  reason: string;
}

const FALLBACK: TriageResult = { isCodeBug: true, confidence: "low", reason: "Triage skipped" };

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
{"isCodeBug": true/false, "confidence": "high/medium/low", "reason": "brief explanation"}

`;

export async function triageError(error: SalesforceError): Promise<TriageResult> {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    logger.info("No CLAUDE_CODE_OAUTH_TOKEN — skipping triage, assuming code bug");
    return FALLBACK;
  }

  try {
    let responseText = "";

    for await (const message of query({
      prompt:
        TRIAGE_PROMPT +
        `Exception type: ${error.exceptionType}\nMessage: ${error.message}\nClass: ${error.apexClass ?? "unknown"}\nStack trace:\n${error.stackTrace}`,
      options: {
        model: "claude-haiku-4-5-20251001",
        maxTurns: 1,
        allowedTools: [],
        settingSources: [],
      },
    })) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") responseText = block.text;
        }
      }
    }

    // Extract JSON even if Claude wraps it in markdown fences
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`Unexpected triage response: ${responseText}`);

    const result = JSON.parse(jsonMatch[0]) as TriageResult;
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
