export const CLAUDE_MODELS = {
  classifier: "claude-sonnet-5-5",
  simple: "claude-opus-5-5",
  complex: "claude-opus-5-5",
  triage: "claude-sonnet-5-5",
} as const;

/**
 * Reasoning effort for the models above. `xhigh` is Anthropic's recommended starting
 * point for long-horizon coding/agentic work and is supported by Sonnet 5.5 and Opus 5.5.
 */
export const CLAUDE_EFFORT = "xhigh" as const;
