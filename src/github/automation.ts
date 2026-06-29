export const PR_ITERATION_COMMENT_MARKER = "<!-- llm-sfdc-gh:pr-iteration-update -->";
export const PR_ITERATION_HISTORY_MARKER = "<!-- llm-sfdc-gh:pr-iteration-history -->";

const AUTOMATION_COMMENT_PREFIXES = [
  "Automated update after feedback from ",
  "Updated this PR after feedback from ",
  "Fix PR opened:",
  "Fix workflow is in progress:",
  "Fix workflow failed:",
  "Iteration workflow is in progress:",
  "Iteration workflow failed:",
  "Planning workflow is in progress:",
  "Plan update workflow is in progress:",
  "Planning workflow failed:",
  "Planning failed.",
  "I received this comment, but no open fix PR was found",
];

export function isAutomationAuthoredComment(body: string): boolean {
  const trimmed = body.trim();

  return (
    trimmed.includes(PR_ITERATION_COMMENT_MARKER) ||
    trimmed.includes(PR_ITERATION_HISTORY_MARKER) ||
    AUTOMATION_COMMENT_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
  );
}

export function stripAutomationSectionsFromPullRequestBody(body: string): string {
  const markerIndex = body.indexOf(PR_ITERATION_HISTORY_MARKER);
  if (markerIndex !== -1) {
    return body.slice(0, markerIndex).trimEnd();
  }

  const legacyHeaderIndex = body.search(/^## Iteration History\s*$/im);
  if (legacyHeaderIndex !== -1) {
    return body.slice(0, legacyHeaderIndex).trimEnd();
  }

  return body.trimEnd();
}
