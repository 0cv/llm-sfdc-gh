A GitHub issue has been selected for planning only.

Create or update an implementation plan for the requested change. You may inspect repository files and use the Salesforce CLI against the authenticated target org for read-only discovery. Do not implement code changes, do not create branches, do not commit, do not push, do not deploy, and do not create a pull request.

## Issue

- Repository: {{REPO_FULL_NAME}}
- Issue: #{{ISSUE_NUMBER}}
- Author: @{{ISSUE_AUTHOR}}
- Title: {{ISSUE_TITLE}}
- Mode: {{PLAN_MODE}}
- Salesforce target org: {{SF_TARGET_ORG}}

## Body

```text
{{ISSUE_BODY}}
```

## Existing Plan

```markdown
{{EXISTING_PLAN}}
```

## New Feedback

- Comment author: @{{COMMENT_AUTHOR}}

```text
{{COMMENT_BODY}}
```

## Issue Discussion

```markdown
{{ISSUE_COMMENTS}}
```

## Instructions

1. Read only the files needed to understand the request and the likely implementation area.
2. If this is an iteration, incorporate the new feedback into the existing plan instead of appending a separate addendum.
3. Preserve useful parts of the existing plan unless the feedback or repository context makes them stale.
4. If the issue is ambiguous, include concrete questions for @{{ISSUE_AUTHOR}}.
5. If the request is clear enough to implement, describe the likely changes, validation, risks, and rollout notes.
6. Keep the plan practical and scoped to this repository.
7. Do not include implementation code unless a tiny snippet is necessary to clarify intent.
8. When org metadata is needed for the plan, use `sf` commands against `{{SF_TARGET_ORG}}` to retrieve or query metadata for analysis. Temporary retrieved metadata may be inspected during the run, but must not be committed or deployed.
9. Output only the complete GitHub issue comment body for the current plan.

Use this format:

```markdown
## Plan

### Understanding
...

### Proposed Changes
...

### Validation
...

### Risks / Questions
...
```
