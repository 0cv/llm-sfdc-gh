#!/usr/bin/env bash
# install-workflows.sh — installs Claude fix workflows into a Salesforce GitHub repo
# Usage: ./scripts/install-workflows.sh owner/repo

set -euo pipefail

REPO="${1:-}"
if [[ -z "$REPO" ]]; then
  echo "Usage: $0 owner/repo" >&2
  exit 1
fi

LLMREPO="0cv/llm-sfdc-gh"

push_workflow() {
  local filename="$1"
  local content="$2"
  local encoded
  encoded=$(echo "$content" | base64)

  # Get current SHA if file exists (required for updates)
  local sha
  sha=$(gh api "repos/$REPO/contents/.github/workflows/$filename" --jq '.sha' 2>/dev/null || true)

  if [[ -n "$sha" ]]; then
    gh api "repos/$REPO/contents/.github/workflows/$filename" \
      -X PUT \
      -f message="ci: update Claude $filename workflow" \
      -f content="$encoded" \
      -f sha="$sha" \
      --silent
    echo "  updated $filename"
  else
    gh api "repos/$REPO/contents/.github/workflows/$filename" \
      -X PUT \
      -f message="ci: add Claude $filename workflow" \
      -f content="$encoded" \
      --silent
    echo "  created $filename"
  fi
}

echo "Installing Claude workflows into $REPO..."

# ── fix-from-error.yml ───────────────────────────────────────────────────────
push_workflow "fix-from-error.yml" "name: Fix Salesforce Error

on:
  repository_dispatch:
    types: [salesforce-error]

jobs:
  fix:
    uses: ${LLMREPO}/.github/workflows/fix-from-error.yml@main
    with:
      exceptionType: \${{ github.event.client_payload.exceptionType }}
      errorMessage: \${{ github.event.client_payload.errorMessage }}
      apexClass: \${{ github.event.client_payload.apexClass }}
      lineNumber: \${{ github.event.client_payload.lineNumber }}
      stackTrace: \${{ github.event.client_payload.stackTrace }}
      rawBody: \${{ github.event.client_payload.rawBody }}
    secrets: inherit
"

# ── fix-from-issue.yml ───────────────────────────────────────────────────────
push_workflow "fix-from-issue.yml" "name: Fix from GitHub Issue

on:
  issues:
    types: [labeled]

jobs:
  fix:
    if: github.event.label.name == 'claude-fix'
    uses: ${LLMREPO}/.github/workflows/fix-from-issue.yml@main
    with:
      issueNumber: \${{ github.event.issue.number }}
      issueTitle: \${{ github.event.issue.title }}
      issueBody: \${{ github.event.issue.body }}
    secrets: inherit
"

# ── iterate-from-review.yml ──────────────────────────────────────────────────
# Three event shapes, each handled separately:
#   pull_request_review       — formal submit (Comment/Request changes): branch in payload
#   pull_request_review_comment — "Add single comment" on a line: branch in payload
#   issue_comment             — Conversation tab comment: branch NOT in payload, fetch via API
push_workflow "iterate-from-review.yml" "name: Iterate on PR Review

on:
  pull_request_review:
    types: [submitted]
  pull_request_review_comment:
    types: [created]
  issue_comment:
    types: [created]

jobs:
  # Formal review (changes_requested or commented) — branch is in the payload
  # Also fires for Copilot reviews (copilot-pull-request-reviewer[bot]), but not for other bots
  on-review:
    if: >
      github.event_name == 'pull_request_review' &&
      github.event.review.state != 'approved' &&
      (github.event.review.user.type != 'Bot' ||
       github.event.review.user.login == 'copilot-pull-request-reviewer[bot]')
    uses: ${LLMREPO}/.github/workflows/iterate-from-review.yml@main
    with:
      prNumber: \${{ github.event.pull_request.number }}
      prTitle: \${{ github.event.pull_request.title }}
      commentBody: \${{ github.event.review.body }}
      commentAuthor: \${{ github.event.review.user.login }}
      prBranch: \${{ github.event.pull_request.head.ref }}
    secrets: inherit

  # Inline line comment ("Add single comment") — branch is in the payload
  # Also fires for Copilot inline comments, but not for other bots
  on-line-comment:
    if: >
      github.event_name == 'pull_request_review_comment' &&
      (github.event.comment.user.type != 'Bot' ||
       github.event.comment.user.login == 'copilot-pull-request-reviewer[bot]')
    uses: ${LLMREPO}/.github/workflows/iterate-from-review.yml@main
    with:
      prNumber: \${{ github.event.pull_request.number }}
      prTitle: \${{ github.event.pull_request.title }}
      commentBody: \${{ github.event.comment.body }}
      commentAuthor: \${{ github.event.comment.user.login }}
      prBranch: \${{ github.event.pull_request.head.ref }}
    secrets: inherit

  # PR Conversation comment — branch is not in payload, fetch it from the API first
  # Also fires for Copilot inline comments, but not for other bots
  get-pr-branch:
    if: >
      github.event_name == 'issue_comment' &&
      github.event.issue.pull_request != null &&
      (github.event.comment.user.type != 'Bot' ||
       github.event.comment.user.login == 'copilot-pull-request-reviewer[bot]')
    runs-on: ubuntu-latest
    outputs:
      branch: \${{ steps.branch.outputs.branch }}
    steps:
      - id: branch
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          PR_NUMBER: \${{ github.event.issue.number }}
        run: |
          branch=\$(gh api repos/\$GITHUB_REPOSITORY/pulls/\$PR_NUMBER --jq '.head.ref')
          echo \"branch=\$branch\" >> \$GITHUB_OUTPUT

  on-comment:
    needs: get-pr-branch
    if: needs.get-pr-branch.result == 'success'
    uses: ${LLMREPO}/.github/workflows/iterate-from-review.yml@main
    with:
      prNumber: \${{ github.event.issue.number }}
      prTitle: \${{ github.event.issue.title }}
      commentBody: \${{ github.event.comment.body }}
      commentAuthor: \${{ github.event.comment.user.login }}
      prBranch: \${{ needs.get-pr-branch.outputs.branch }}
    secrets: inherit
"

# ── init-repo.yml ────────────────────────────────────────────────────────────
# Manually triggered once per repo to generate CLAUDE.md with org conventions.
push_workflow "init-repo.yml" "name: Init Repo (generate CLAUDE.md)

on:
  workflow_dispatch:

jobs:
  init:
    uses: ${LLMREPO}/.github/workflows/init-repo.yml@main
    secrets: inherit
"

# ── Create claude-fix label ──────────────────────────────────────────────────
gh label create "claude-fix" \
  --repo "$REPO" \
  --color "5319e7" \
  --description "Ask Claude to diagnose and fix this issue" \
  --force
echo "  label 'claude-fix' ready"

echo "Done. Workflows installed in $REPO/.github/workflows/"
echo ""
echo "Ensure the following secrets are set in $REPO (Settings → Secrets → Actions):"
echo "  CLAUDE_CODE_OAUTH_TOKEN  — OAuth token from: claude setup-token  (or set at org level)"
echo "  SF_AUTH_URL        — force://PlatformCLI::<token>@yourorg.my.salesforce.com"
