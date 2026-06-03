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
  encoded=$(printf '%s\n' "$content" | base64 | tr -d '\n')

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

render_workflow() {
  local content="$1"
  printf '%s' "${content//__LLMREPO__/$LLMREPO}"
}

echo "Installing Claude workflows into $REPO..."

# ── fix-from-error.yml ───────────────────────────────────────────────────────
fix_from_error_workflow=$(cat <<'YAML'
name: Fix Salesforce Error

on:
  repository_dispatch:
    types: [salesforce-error]

permissions:
  contents: write
  pull-requests: write

jobs:
  fix:
    uses: __LLMREPO__/.github/workflows/fix-from-error.yml@main
    with:
      subject: ${{ github.event.client_payload.subject }}
      orgName: ${{ github.event.client_payload.orgName }}
      exceptionType: ${{ github.event.client_payload.exceptionType }}
      errorMessage: ${{ github.event.client_payload.errorMessage }}
      apexClass: ${{ github.event.client_payload.apexClass }}
      triggerName: ${{ github.event.client_payload.triggerName }}
      triggerOperation: ${{ github.event.client_payload.triggerOperation }}
      lineNumber: ${{ github.event.client_payload.lineNumber }}
      stackTrace: ${{ github.event.client_payload.stackTrace }}
      rawBody: ${{ github.event.client_payload.rawBody }}
    secrets: inherit
YAML
)
push_workflow "fix-from-error.yml" "$(render_workflow "$fix_from_error_workflow")"

# ── fix-from-issue.yml ───────────────────────────────────────────────────────
fix_from_issue_workflow=$(cat <<'YAML'
name: Fix from GitHub Issue

on:
  issues:
    types: [labeled]

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  mark-started:
    if: github.event.label.name == 'claude-fix'
    runs-on: ubuntu-latest
    steps:
      - env:
          GH_TOKEN: ${{ github.token }}
          ISSUE_NUMBER: ${{ github.event.issue.number }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: |
          gh api "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels" -f labels[]="claude-fix-in-progress" >/dev/null
          gh api -X DELETE "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels/claude-fix-ready" >/dev/null 2>&1 || true
          gh api -X DELETE "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels/claude-fix-failed" >/dev/null 2>&1 || true
          gh api -X DELETE "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels/claude-fix-needs-info" >/dev/null 2>&1 || true
          gh api "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/comments" \
            -f body="Fix workflow is in progress: $RUN_URL" >/dev/null

  fix:
    needs: mark-started
    if: github.event.label.name == 'claude-fix' && needs.mark-started.result == 'success'
    uses: __LLMREPO__/.github/workflows/fix-from-issue.yml@main
    with:
      issueNumber: ${{ github.event.issue.number }}
      issueTitle: ${{ github.event.issue.title }}
      issueBody: ${{ github.event.issue.body }}
      issueAuthor: ${{ github.event.issue.user.login }}
    secrets: inherit

  mark-finished:
    needs: [mark-started, fix]
    if: always() && github.event.label.name == 'claude-fix' && needs.mark-started.result == 'success'
    runs-on: ubuntu-latest
    steps:
      - env:
          GH_TOKEN: ${{ github.token }}
          ISSUE_NUMBER: ${{ github.event.issue.number }}
          FIX_RESULT: ${{ needs.fix.result }}
          FIX_OUTCOME: ${{ needs.fix.outputs.outcome }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: |
          gh api -X DELETE "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels/claude-fix-in-progress" >/dev/null 2>&1 || true

          if [[ "$FIX_RESULT" == "success" && "$FIX_OUTCOME" == "clarification_requested" ]]; then
            gh api -X DELETE "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels/claude-fix-ready" >/dev/null 2>&1 || true
            gh api -X DELETE "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels/claude-fix-failed" >/dev/null 2>&1 || true
            gh api "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels" -f labels[]="claude-fix-needs-info" >/dev/null
          elif [[ "$FIX_RESULT" == "success" ]]; then
            gh api -X DELETE "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels/claude-fix-failed" >/dev/null 2>&1 || true
            gh api -X DELETE "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels/claude-fix-needs-info" >/dev/null 2>&1 || true
            gh api "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels" -f labels[]="claude-fix-ready" >/dev/null
          else
            gh api -X DELETE "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels/claude-fix-ready" >/dev/null 2>&1 || true
            gh api -X DELETE "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels/claude-fix-needs-info" >/dev/null 2>&1 || true
            gh api "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels" -f labels[]="claude-fix-failed" >/dev/null
            gh api "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/comments" \
              -f body="Fix workflow failed: $RUN_URL" >/dev/null
          fi
YAML
)
push_workflow "fix-from-issue.yml" "$(render_workflow "$fix_from_issue_workflow")"

# ── iterate-from-review.yml ──────────────────────────────────────────────────
iterate_from_review_workflow=$(cat <<'YAML'
name: Iterate on PR Review

on:
  pull_request_review:
    types: [submitted]
  pull_request_review_comment:
    types: [created]
  issue_comment:
    types: [created]

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  # Formal review (changes_requested or commented) — branch is in the payload
  # Also fires for Copilot reviews (copilot-pull-request-reviewer[bot]), but not for other bots
  on-review:
    if: >
      github.event_name == 'pull_request_review' &&
      github.event.review.state != 'approved' &&
      (github.event.review.user.type != 'Bot' ||
       github.event.review.user.login == 'copilot-pull-request-reviewer[bot]')
    uses: __LLMREPO__/.github/workflows/iterate-from-review.yml@main
    with:
      prNumber: ${{ github.event.pull_request.number }}
      prTitle: ${{ github.event.pull_request.title }}
      commentBody: ${{ github.event.review.body }}
      commentAuthor: ${{ github.event.review.user.login }}
      prBranch: ${{ github.event.pull_request.head.ref }}
    secrets: inherit

  # Inline line comment ("Add single comment") — branch is in the payload
  # Also fires for Copilot inline comments, but not for other bots
  on-line-comment:
    if: >
      github.event_name == 'pull_request_review_comment' &&
      (github.event.comment.user.type != 'Bot' ||
       github.event.comment.user.login == 'copilot-pull-request-reviewer[bot]')
    uses: __LLMREPO__/.github/workflows/iterate-from-review.yml@main
    with:
      prNumber: ${{ github.event.pull_request.number }}
      prTitle: ${{ github.event.pull_request.title }}
      commentBody: ${{ github.event.comment.body }}
      commentAuthor: ${{ github.event.comment.user.login }}
      prBranch: ${{ github.event.pull_request.head.ref }}
    secrets: inherit

  # PR conversation comment — branch is not in payload, fetch it from the API first
  get-pr-branch:
    if: >
      github.event_name == 'issue_comment' &&
      github.event.issue.pull_request != null &&
      (github.event.comment.user.type != 'Bot' ||
       github.event.comment.user.login == 'copilot-pull-request-reviewer[bot]')
    runs-on: ubuntu-latest
    outputs:
      branch: ${{ steps.branch.outputs.branch }}
    steps:
      - id: branch
        env:
          GH_TOKEN: ${{ github.token }}
          PR_NUMBER: ${{ github.event.issue.number }}
        run: |
          branch=$(gh api repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER --jq '.head.ref')
          echo "branch=$branch" >> "$GITHUB_OUTPUT"

  on-pr-comment:
    needs: get-pr-branch
    if: needs.get-pr-branch.result == 'success'
    uses: __LLMREPO__/.github/workflows/iterate-from-review.yml@main
    with:
      prNumber: ${{ github.event.issue.number }}
      prTitle: ${{ github.event.issue.title }}
      commentBody: ${{ github.event.comment.body }}
      commentAuthor: ${{ github.event.comment.user.login }}
      prBranch: ${{ needs.get-pr-branch.outputs.branch }}
    secrets: inherit

  # Original issue comment — resolve the open fix PR, then iterate on that PR
  find-issue-pr:
    if: >
      github.event_name == 'issue_comment' &&
      github.event.issue.pull_request == null &&
      contains(github.event.issue.labels.*.name, 'claude-fix') &&
      github.event.comment.user.type != 'Bot'
    runs-on: ubuntu-latest
    outputs:
      found: ${{ steps.pr.outputs.found }}
      number: ${{ steps.pr.outputs.number }}
      title: ${{ steps.pr.outputs.title }}
      branch: ${{ steps.pr.outputs.branch }}
    steps:
      - id: pr
        env:
          GH_TOKEN: ${{ github.token }}
          ISSUE_NUMBER: ${{ github.event.issue.number }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: |
          match=""
          pattern="(fixes|closes|resolves|refs?) +#${ISSUE_NUMBER}([^0-9]|$)"

          while IFS= read -r encoded_pr; do
            pr_json=$(printf '%s' "$encoded_pr" | base64 -d)
            body=$(jq -r '.body // ""' <<< "$pr_json")
            branch=$(jq -r '.head.ref' <<< "$pr_json")

            if [[ "$branch" == "fix/issue-$ISSUE_NUMBER" ]] || grep -Eiq "$pattern" <<< "$body"; then
              match="$pr_json"
              break
            fi
          done < <(gh api --paginate "repos/$GITHUB_REPOSITORY/pulls?state=open&sort=created&direction=desc&per_page=100" --jq '.[] | @base64')

          if [[ -z "$match" ]]; then
            echo "found=false" >> "$GITHUB_OUTPUT"
            exit 0
          fi

          gh api "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels" \
            -f labels[]="claude-fix-in-progress" >/dev/null
          gh api -X DELETE "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels/claude-fix-ready" >/dev/null 2>&1 || true
          gh api -X DELETE "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels/claude-fix-failed" >/dev/null 2>&1 || true
          gh api "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/comments" \
            -f body="Iteration workflow is in progress: $RUN_URL" >/dev/null

          {
            echo "found=true"
            echo "number=$(jq -r '.number' <<< "$match")"
            echo "branch=$(jq -r '.head.ref' <<< "$match")"
            echo "title<<EOF"
            jq -r '.title' <<< "$match"
            echo "EOF"
          } >> "$GITHUB_OUTPUT"

  on-issue-comment:
    needs: find-issue-pr
    if: needs.find-issue-pr.result == 'success' && needs.find-issue-pr.outputs.found == 'true'
    uses: __LLMREPO__/.github/workflows/iterate-from-review.yml@main
    with:
      prNumber: ${{ needs.find-issue-pr.outputs.number }}
      prTitle: ${{ needs.find-issue-pr.outputs.title }}
      commentBody: ${{ github.event.comment.body }}
      commentAuthor: ${{ github.event.comment.user.login }}
      prBranch: ${{ needs.find-issue-pr.outputs.branch }}
    secrets: inherit

  on-issue-comment-finished:
    needs: [find-issue-pr, on-issue-comment]
    if: always() && needs.find-issue-pr.result == 'success' && needs.find-issue-pr.outputs.found == 'true'
    runs-on: ubuntu-latest
    steps:
      - env:
          GH_TOKEN: ${{ github.token }}
          ISSUE_NUMBER: ${{ github.event.issue.number }}
          ITERATION_RESULT: ${{ needs.on-issue-comment.result }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: |
          gh api -X DELETE "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels/claude-fix-in-progress" >/dev/null 2>&1 || true

          if [[ "$ITERATION_RESULT" == "success" ]]; then
            gh api -X DELETE "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels/claude-fix-failed" >/dev/null 2>&1 || true
            gh api "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels" \
              -f labels[]="claude-fix-ready" >/dev/null
          else
            gh api "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels" \
              -f labels[]="claude-fix-failed" >/dev/null
            gh api "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/comments" \
              -f body="Iteration workflow failed: $RUN_URL" >/dev/null
          fi

  on-issue-comment-no-open-pr:
    needs: find-issue-pr
    if: needs.find-issue-pr.result == 'success' && needs.find-issue-pr.outputs.found != 'true'
    runs-on: ubuntu-latest
    steps:
      - env:
          GH_TOKEN: ${{ github.token }}
          ISSUE_NUMBER: ${{ github.event.issue.number }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: |
          body="I received this comment, but no open fix PR was found for this issue. Workflow run: $RUN_URL"
          gh api "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/comments" -f body="$body" >/dev/null
YAML
)
push_workflow "iterate-from-review.yml" "$(render_workflow "$iterate_from_review_workflow")"

# ── init-repo.yml ────────────────────────────────────────────────────────────
init_repo_workflow=$(cat <<'YAML'
name: Init Repo (generate CLAUDE.md)

on:
  workflow_dispatch:

permissions:
  contents: write

jobs:
  init:
    uses: __LLMREPO__/.github/workflows/init-repo.yml@main
    secrets: inherit
YAML
)
push_workflow "init-repo.yml" "$(render_workflow "$init_repo_workflow")"

# ── Create claude-fix label ──────────────────────────────────────────────────
ensure_label() {
  local name="$1"
  local color="$2"
  local description="$3"

  gh label create "$name" \
    --repo "$REPO" \
    --color "$color" \
    --description "$description" \
    --force
  echo "  label '$name' ready"
}

ensure_label "claude-fix" "5319e7" "Ask Claude to diagnose and fix this issue"
ensure_label "claude-fix-in-progress" "fbca04" "Claude fix workflow is currently running"
ensure_label "claude-fix-ready" "0e8a16" "Claude opened or updated a fix PR"
ensure_label "claude-fix-failed" "b60205" "Claude fix workflow failed"
ensure_label "claude-fix-needs-info" "d4c5f9" "Claude asked the issue author for clarification"

echo "Done. Workflows installed in $REPO/.github/workflows/"
echo ""
echo "Required secret — set per repo (Settings → Secrets → Actions):"
echo "  SF_AUTH_URL   — force://PlatformCLI::<token>@yourorg.my.salesforce.com"
echo ""
echo "  CLAUDE_CODE_OAUTH_TOKEN should be set once at the GitHub org level"
echo "  (Org Settings → Secrets → Actions) and granted to this repo."
echo "  If not using an org, set it per repo as well."
echo ""
echo "Then run the init workflow once to generate CLAUDE.md:"
echo "  gh workflow run init-repo.yml --repo $REPO"
