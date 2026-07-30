export const CLAUDE_MODELS = {
  classifier: "claude-sonnet-5",
  simple: "claude-opus-4-8",
  complex: "claude-opus-5",
  triage: "claude-haiku-4-5-20251001",
} as const;

/**
 * Reasoning effort for the models above. `xhigh` is Anthropic's recommended starting
 * point for long-horizon coding/agentic work and is supported by Sonnet 5, Opus 4.8
 * and Opus 5.
 *
 * Deliberately not applied to `triage`: Haiku 4.5 has no effort parameter.
 */
export const CLAUDE_EFFORT = "xhigh" as const;
