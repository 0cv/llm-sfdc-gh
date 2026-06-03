/**
 * Claude Agent SDK wrapper for spawning headless coding sessions.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "../utils/logger.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface SessionResult {
  success: boolean;
  summary: string;
  prUrl: string | null;
}

interface ClaudeSessionOptions {
  allowedTools?: string[];
  maxTurns?: number;
  summaryMaxChars?: number;
}

/**
 * Load a prompt template from the prompts/ directory and interpolate variables.
 */
async function loadPrompt(name: string, vars: Record<string, string>): Promise<string> {
  const templatePath = join(import.meta.dirname, "..", "..", "prompts", `${name}.md`);
  let template = await readFile(templatePath, "utf-8");
  for (const [key, value] of Object.entries(vars)) {
    template = template.replaceAll(`{{${key}}}`, value);
  }
  return template;
}

/**
 * Run a Claude Agent SDK session against the Salesforce repo.
 */
export async function runClaudeSession(
  promptName: string,
  vars: Record<string, string>,
  model?: string,
  sessionOptions: ClaudeSessionOptions = {}
): Promise<SessionResult> {
  const prompt = await loadPrompt(promptName, vars);

  logger.info({ promptName, model }, "Starting Claude session");

  let lastAssistantText = "";
  let prUrl: string | null = null;

  try {
    for await (const message of query({
      prompt,
      options: {
        model,
        maxTurns: sessionOptions.maxTurns ?? parseInt(process.env.MAX_CLAUDE_TURNS || "40"),
        allowedTools: sessionOptions.allowedTools ?? [
          "Read",
          "Edit",
          "Write",
          "Bash",
          "Glob",
          "Grep",
        ],
        cwd: process.cwd(),
        // Load CLAUDE.md and project settings from the SF repo (defaults to [] in 0.1+)
        settingSources: ["project"],
      },
    })) {
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") {
            lastAssistantText = block.text;
            logger.info({ text: block.text }, "[Claude] text");

            const prMatch = block.text.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/);
            if (prMatch) prUrl = prMatch[0];
          }
          if (block.type === "tool_use") {
            logger.info({ tool: block.name, input: block.input }, "[Claude] tool_use");
          }
        }
      }
      if (message.type === "result") {
        logger.info({ subtype: message.subtype }, "[Claude] result");
      }
    }

    logger.info({ prUrl }, "Claude session completed");

    return {
      success: true,
      summary: lastAssistantText.slice(0, sessionOptions.summaryMaxChars ?? 500),
      prUrl,
    };
  } catch (err) {
    logger.error(err, "Claude session failed");
    return {
      success: false,
      summary: String(err),
      prUrl: null,
    };
  }
}
