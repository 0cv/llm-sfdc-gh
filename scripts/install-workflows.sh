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
      issueNumber: \${{ github.event.issue.number | toString }}
      issueTitle: \${{ github.event.issue.title }}
      issueBody: \${{ github.event.issue.body }}
    secrets: inherit
"

# ── iterate-from-review.yml ──────────────────────────────────────────────────
push_workflow "iterate-from-review.yml" "name: Iterate on PR Review

on:
  pull_request_review:
    types: [submitted]
  issue_comment:
    types: [created]

jobs:
  iterate:
    if: |
      (github.event_name == 'pull_request_review' && github.event.review.state == 'changes_requested') ||
      (github.event_name == 'issue_comment' && github.event.issue.pull_request != null && !contains(github.event.comment.user.login, '[bot]'))
    uses: ${LLMREPO}/.github/workflows/iterate-from-review.yml@main
    with:
      prNumber: \${{ github.event.pull_request.number || github.event.issue.number | toString }}
      prTitle: \${{ github.event.pull_request.title || github.event.issue.title }}
      commentBody: \${{ github.event.review.body || github.event.comment.body }}
      commentAuthor: \${{ github.event.review.user.login || github.event.comment.user.login }}
      prBranch: \${{ github.event.pull_request.head.ref || github.head_ref }}
    secrets: inherit
"

echo "Done. Workflows installed in $REPO/.github/workflows/"
echo ""
echo "Ensure the following secrets are set in $REPO (Settings → Secrets → Actions):"
echo "  ANTHROPIC_API_KEY  — Anthropic API key (or set at org level)"
echo "  SF_AUTH_URL        — force://PlatformCLI::<token>@yourorg.my.salesforce.com"
