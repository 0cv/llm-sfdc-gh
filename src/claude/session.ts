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
  branchName: string | null;
  prUrl: string | null;
}

/**
 * Load a prompt template from the prompts/ directory and interpolate variables.
 */
async function loadPrompt(
  name: string,
  vars: Record<string, string>
): Promise<string> {
  const templatePath = join(
    import.meta.dirname,
    "..",
    "..",
    "prompts",
    `${name}.md`
  );
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
  vars: Record<string, string>
): Promise<SessionResult> {
  const prompt = await loadPrompt(promptName, vars);

  logger.info({ promptName }, "Starting Claude session");

  let lastAssistantText = "";
  let branchName: string | null = null;
  let prUrl: string | null = null;

  try {
    for await (const message of query({
      prompt,
      options: {
        maxTurns: parseInt(process.env.MAX_CLAUDE_TURNS || "40"),
        allowedTools: [
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

            const branchMatch = block.text.match(
              /branch[:\s]+[`']?([a-zA-Z0-9/_-]+)[`']?/i
            );
            if (branchMatch) branchName = branchMatch[1];

            const prMatch = block.text.match(
              /https:\/\/github\.com\/[^\s)]+\/pull\/\d+/
            );
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

    logger.info({ branchName, prUrl }, "Claude session completed");

    return {
      success: true,
      summary: lastAssistantText.slice(0, 500),
      branchName,
      prUrl,
    };
  } catch (err) {
    logger.error(err, "Claude session failed");
    return {
      success: false,
      summary: String(err),
      branchName: null,
      prUrl: null,
    };
  }
}
