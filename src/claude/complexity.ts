/**
 * Classifies the complexity of a Claude task to route to the right model.
 * Simple → Sonnet. Complex → Opus.
 *
 * Uses query() (agent SDK) instead of the direct Anthropic SDK so that
 * CLAUDE_CODE_OAUTH_TOKEN is handled correctly by the claude CLI.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "../utils/logger.js";

const SONNET = "claude-sonnet-4-6";
const OPUS = "claude-opus-4-6";

const PROMPT = `You are a Salesforce engineering complexity classifier.
Given a task description, classify it as "simple" or "complex".

Simple: single-file fix, renaming, null check, adding a log, one-line logic correction.
Complex: new custom objects or metadata, architectural refactor, multi-file changes, governor limit issues (SOQL/DML in loops), async patterns (future/queueable/batch), security model changes, ambiguous requirements needing deep reasoning.

Respond with exactly one line: COMPLEXITY: simple  OR  COMPLEXITY: complex

Task:
`;

export async function pickModel(taskSummary: string): Promise<string> {
  try {
    let responseText = "";

    for await (const message of query({
      prompt: PROMPT + taskSummary,
      options: {
        model: SONNET,
        maxTurns: 1,
        allowedTools: [],
        settingSources: [],
      },
    })) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") {
            responseText = block.text;
          }
        }
      }
    }

    const match = responseText.match(/COMPLEXITY:\s*(simple|complex)/i);
    const complexity = match?.[1]?.toLowerCase() ?? "simple";
    const model = complexity === "complex" ? OPUS : SONNET;

    logger.info({ complexity, model }, "Model selected");
    return model;
  } catch (err) {
    logger.warn({ err }, "Complexity classification failed, defaulting to Sonnet");
    return SONNET;
  }
}
