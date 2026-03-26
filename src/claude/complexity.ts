/**
 * Classifies the complexity of a Claude task to route to the right model.
 * Simple → Sonnet. Complex → Opus.
 */

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../utils/logger.js";

const SONNET = "claude-sonnet-4-6";
const OPUS = "claude-opus-4-6";

const SYSTEM = `You are a Salesforce engineering complexity classifier.
Given a task description, classify it as "simple" or "complex".

Simple: single-file fix, renaming, null check, adding a log, one-line logic correction.
Complex: new custom objects or metadata, architectural refactor, multi-file changes, governor limit issues (SOQL/DML in loops), async patterns (future/queueable/batch), security model changes, ambiguous requirements needing deep reasoning.

Respond with exactly one line: COMPLEXITY: simple  OR  COMPLEXITY: complex`;

export async function pickModel(taskSummary: string): Promise<string> {
  const authToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!authToken) {
    logger.warn("CLAUDE_CODE_OAUTH_TOKEN not set, defaulting to Sonnet");
    return SONNET;
  }

  try {
    const anthropic = new Anthropic({ authToken });
    const response = await anthropic.messages.create({
      model: SONNET,
      max_tokens: 20,
      system: SYSTEM,
      messages: [{ role: "user", content: taskSummary }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const match = text.match(/COMPLEXITY:\s*(simple|complex)/i);
    const complexity = match?.[1]?.toLowerCase() ?? "simple";
    const model = complexity === "complex" ? OPUS : SONNET;

    logger.info({ complexity, model }, "Model selected");
    return model;
  } catch (err) {
    logger.warn({ err }, "Complexity classification failed, defaulting to Sonnet");
    return SONNET;
  }
}
