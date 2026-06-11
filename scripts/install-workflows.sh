#!/usr/bin/env bash
# install-workflows.sh — installs Claude workflows into a Salesforce GitHub repo
# Usage: ./scripts/install-workflows.sh owner/repo [base-branch] [--pr]

set -euo pipefail

REPO="${1:-}"
if [[ -z "$REPO" ]]; then
  echo "Usage: $0 owner/repo [base-branch] [--pr]" >&2
  exit 1
fi

INSTALL_MODE="direct"
BASE_BRANCH=""
if [[ "${2:-}" == "--pr" ]]; then
  INSTALL_MODE="pr"
elif [[ "${3:-}" == "--pr" ]]; then
  BASE_BRANCH="${2:-}"
  INSTALL_MODE="pr"
else
  BASE_BRANCH="${2:-}"
fi

if [[ -z "$BASE_BRANCH" ]]; then
  BASE_BRANCH=$(gh repo view "$REPO" --json defaultBranchRef --jq '.defaultBranchRef.name')
fi

LLMREPO="0cv/llm-sfdc-gh"
INSTALL_BRANCH="claude-install-workflows-${BASE_BRANCH//\//-}"

ensure_install_branch() {
  if [[ "$INSTALL_MODE" != "pr" ]]; then
    return
  fi

  if gh api "repos/$REPO/git/ref/heads/$INSTALL_BRANCH" --silent 2>/dev/null; then
    echo "  using existing install branch $INSTALL_BRANCH"
    return
  fi

  local base_sha
  base_sha=$(gh api "repos/$REPO/git/ref/heads/$BASE_BRANCH" --jq '.object.sha')
  gh api "repos/$REPO/git/refs" \
    -f ref="refs/heads/$INSTALL_BRANCH" \
    -f sha="$base_sha" \
    --silent
  echo "  created install branch $INSTALL_BRANCH from $BASE_BRANCH"
}

push_workflow() {
  local filename="$1"
  local content="$2"
  local desired
  local encoded
  desired=$(printf '%s' "$content")
  encoded=$(printf '%s\n' "$content" | base64 | tr -d '\n')

  local target_branch="$BASE_BRANCH"
  if [[ "$INSTALL_MODE" == "pr" ]]; then
    target_branch="$INSTALL_BRANCH"
  fi
  local ref_suffix="?ref=$target_branch"

  # Get current SHA/content if file exists (SHA is required for updates).
  local current
  local sha
  current=$(gh api "repos/$REPO/contents/.github/workflows/$filename$ref_suffix" 2>/dev/null || true)
  sha=$(printf '%s' "$current" | jq -r 'if has("sha") then .sha else "" end' 2>/dev/null || true)

  if [[ -n "$sha" ]]; then
    local existing
    existing=$(printf '%s' "$current" | jq -r '.content' | base64 --decode)
    if [[ "$existing" == "$desired" ]]; then
      echo "  unchanged $filename"
      return
    fi

    gh api "repos/$REPO/contents/.github/workflows/$filename" \
      -X PUT \
      -f message="ci: update Claude $filename workflow" \
      -f content="$encoded" \
      -f sha="$sha" \
      -f branch="$target_branch" \
      --silent
    echo "  updated $filename"
  else
    gh api "repos/$REPO/contents/.github/workflows/$filename" \
      -X PUT \
      -f message="ci: add Claude $filename workflow" \
      -f content="$encoded" \
      -f branch="$target_branch" \
      --silent
    echo "  created $filename"
  fi
}

open_install_pr() {
  if [[ "$INSTALL_MODE" != "pr" ]]; then
    return
  fi

  local existing_pr
  existing_pr=$(gh pr list \
    --repo "$REPO" \
    --head "$INSTALL_BRANCH" \
    --base "$BASE_BRANCH" \
    --state open \
    --json url \
    --jq '.[0].url // ""')

  if [[ -n "$existing_pr" ]]; then
    echo "  install PR already open: $existing_pr"
    return
  fi

  gh pr create \
    --repo "$REPO" \
    --head "$INSTALL_BRANCH" \
    --base "$BASE_BRANCH" \
    --title "ci: install Claude workflows" \
    --body "Installs Claude issue, planning, review-iteration, error-dispatch, and init workflows targeting \`$BASE_BRANCH\`." \
    >/dev/null

  gh pr list \
    --repo "$REPO" \
    --head "$INSTALL_BRANCH" \
    --base "$BASE_BRANCH" \
    --state open \
    --json url \
    --jq '.[0].url'
}

render_workflow() {
  local content="$1"
  content="${content//__LLMREPO__/$LLMREPO}"
  printf '%s' "${content//__BASE_BRANCH__/$BASE_BRANCH}"
}

echo "Installing Claude workflows into $REPO..."
echo "Using base branch: $BASE_BRANCH"
if [[ "$INSTALL_MODE" == "pr" ]]; then
  echo "Install mode: pull request"
fi
ensure_install_branch

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
      baseBranch: __BASE_BRANCH__
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      SF_AUTH_URL: ${{ secrets.SF_AUTH_URL }}
YAML
)
push_workflow "fix-from-error.yml" "$(render_workflow "$fix_from_error_workflow")"

# ── fix-from-issue.yml ───────────────────────────────────────────────────────
fix_from_issue_workflow=$(cat <<'YAML'
name: Fix from GitHub Issue

on:
  issues:
    types: [labeled]

concurrency:
  group: claude-fix-${{ github.repository }}-${{ github.event.issue.number }}
  cancel-in-progress: false

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
      baseBranch: __BASE_BRANCH__
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      SF_AUTH_URL: ${{ secrets.SF_AUTH_URL }}

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

# ── plan-from-issue.yml ──────────────────────────────────────────────────────
plan_from_issue_workflow=$(cat <<'YAML'
name: Plan from GitHub Issue

on:
  issues:
    types: [labeled]
  issue_comment:
    types: [created]

concurrency:
  group: claude-plan-${{ github.repository }}-${{ github.event.issue.number }}
  cancel-in-progress: false

permissions:
  contents: read
  issues: write

jobs:
  mark_label_started:
    if: github.event_name == 'issues' && github.event.label.name == 'claude-plan'
    runs-on: ubuntu-latest
    steps:
      - env:
          GH_TOKEN: ${{ github.token }}
          ISSUE_NUMBER: ${{ github.event.issue.number }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: |
          gh api "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels" -f labels[]="claude-plan-in-progress" >/dev/null
          gh api -X DELETE "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels/claude-plan-ready" >/dev/null 2>&1 || true
          gh api -X DELETE "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels/claude-plan-failed" >/dev/null 2>&1 || true
          gh api "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/comments" \
            -f body="Planning workflow is in progress: $RUN_URL" >/dev/null

  plan_from_label:
    needs: mark_label_started
    if: github.event_name == 'issues' && github.event.label.name == 'claude-plan' && needs.mark_label_started.result == 'success'
    uses: __LLMREPO__/.github/workflows/plan-from-issue.yml@main
    with:
      issueNumber: ${{ github.event.issue.number }}
      issueTitle: ${{ github.event.issue.title }}
      issueBody: ${{ github.event.issue.body }}
      issueAuthor: ${{ github.event.issue.user.login }}
      baseBranch: __BASE_BRANCH__
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      SF_AUTH_URL: ${{ secrets.SF_AUTH_URL }}

  mark_label_finished:
    needs: [mark_label_started, plan_from_label]
    if: always() && github.event_name == 'issues' && github.event.label.name == 'claude-plan' && needs.mark_label_started.result == 'success'
    runs-on: ubuntu-latest
    steps:
      - env:
          GH_TOKEN: ${{ github.token }}
          ISSUE_NUMBER: ${{ github.event.issue.number }}
          PLAN_RESULT: ${{ needs.plan_from_label.result }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: |
          gh api -X DELETE "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels/claude-plan-in-progress" >/dev/null 2>&1 || true

          if [[ "$PLAN_RESULT" == "success" ]]; then
            gh api -X DELETE "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels/claude-plan-failed" >/dev/null 2>&1 || true
            gh api "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels" -f labels[]="claude-plan-ready" >/dev/null
          else
            gh api -X DELETE "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels/claude-plan-ready" >/dev/null 2>&1 || true
            gh api "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels" -f labels[]="claude-plan-failed" >/dev/null
            gh api "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/comments" \
              -f body="Planning workflow failed: $RUN_URL" >/dev/null
          fi

  mark_comment_started:
    if: >
      github.event_name == 'issue_comment' &&
      github.event.issue.pull_request == null &&
      github.event.comment.user.type != 'Bot' &&
      contains(github.event.issue.labels.*.name, 'claude-plan-ready')
    runs-on: ubuntu-latest
    steps:
      - env:
          GH_TOKEN: ${{ github.token }}
          ISSUE_NUMBER: ${{ github.event.issue.number }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: |
          gh api "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels" -f labels[]="claude-plan-in-progress" >/dev/null
          gh api -X DELETE "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels/claude-plan-ready" >/dev/null 2>&1 || true
          gh api -X DELETE "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels/claude-plan-failed" >/dev/null 2>&1 || true
          gh api "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/comments" \
            -f body="Plan update workflow is in progress: $RUN_URL" >/dev/null

  plan_from_comment:
    needs: mark_comment_started
    if: >
      github.event_name == 'issue_comment' &&
      github.event.issue.pull_request == null &&
      github.event.comment.user.type != 'Bot' &&
      contains(github.event.issue.labels.*.name, 'claude-plan-ready') &&
      needs.mark_comment_started.result == 'success'
    uses: __LLMREPO__/.github/workflows/plan-from-issue.yml@main
    with:
      issueNumber: ${{ github.event.issue.number }}
      issueTitle: ${{ github.event.issue.title }}
      issueBody: ${{ github.event.issue.body }}
      issueAuthor: ${{ github.event.issue.user.login }}
      commentBody: ${{ github.event.comment.body }}
      commentAuthor: ${{ github.event.comment.user.login }}
      baseBranch: __BASE_BRANCH__
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      SF_AUTH_URL: ${{ secrets.SF_AUTH_URL }}

  mark_comment_finished:
    needs: [mark_comment_started, plan_from_comment]
    if: >
      always() &&
      github.event_name == 'issue_comment' &&
      github.event.issue.pull_request == null &&
      github.event.comment.user.type != 'Bot' &&
      contains(github.event.issue.labels.*.name, 'claude-plan-ready') &&
      needs.mark_comment_started.result == 'success'
    runs-on: ubuntu-latest
    steps:
      - env:
          GH_TOKEN: ${{ github.token }}
          ISSUE_NUMBER: ${{ github.event.issue.number }}
          PLAN_RESULT: ${{ needs.plan_from_comment.result }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: |
          gh api -X DELETE "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels/claude-plan-in-progress" >/dev/null 2>&1 || true

          if [[ "$PLAN_RESULT" == "success" ]]; then
            gh api -X DELETE "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels/claude-plan-failed" >/dev/null 2>&1 || true
            gh api "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels" -f labels[]="claude-plan-ready" >/dev/null
          else
            gh api -X DELETE "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels/claude-plan-ready" >/dev/null 2>&1 || true
            gh api "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/labels" -f labels[]="claude-plan-failed" >/dev/null
            gh api "repos/$GITHUB_REPOSITORY/issues/$ISSUE_NUMBER/comments" \
              -f body="Plan update workflow failed: $RUN_URL" >/dev/null
          fi
YAML
)
push_workflow "plan-from-issue.yml" "$(render_workflow "$plan_from_issue_workflow")"

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

concurrency:
  group: claude-iterate-${{ github.repository }}-${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: false

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
      github.event.pull_request.base.ref == '__BASE_BRANCH__' &&
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
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      SF_AUTH_URL: ${{ secrets.SF_AUTH_URL }}

  # Inline line comment ("Add single comment") — branch is in the payload
  # Also fires for Copilot inline comments, but not for other bots
  on-line-comment:
    if: >
      github.event_name == 'pull_request_review_comment' &&
      github.event.pull_request.base.ref == '__BASE_BRANCH__' &&
      (github.event.comment.user.type != 'Bot' ||
       github.event.comment.user.login == 'copilot-pull-request-reviewer[bot]')
    uses: __LLMREPO__/.github/workflows/iterate-from-review.yml@main
    with:
      prNumber: ${{ github.event.pull_request.number }}
      prTitle: ${{ github.event.pull_request.title }}
      commentBody: ${{ github.event.comment.body }}
      commentAuthor: ${{ github.event.comment.user.login }}
      prBranch: ${{ github.event.pull_request.head.ref }}
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      SF_AUTH_URL: ${{ secrets.SF_AUTH_URL }}

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
      base: ${{ steps.branch.outputs.base }}
    steps:
      - id: branch
        env:
          GH_TOKEN: ${{ github.token }}
          PR_NUMBER: ${{ github.event.issue.number }}
        run: |
          pr_json=$(gh api repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER)
          branch=$(jq -r '.head.ref' <<< "$pr_json")
          base=$(jq -r '.base.ref' <<< "$pr_json")
          echo "branch=$branch" >> "$GITHUB_OUTPUT"
          echo "base=$base" >> "$GITHUB_OUTPUT"

  on-pr-comment:
    needs: get-pr-branch
    if: needs.get-pr-branch.result == 'success' && needs.get-pr-branch.outputs.base == '__BASE_BRANCH__'
    uses: __LLMREPO__/.github/workflows/iterate-from-review.yml@main
    with:
      prNumber: ${{ github.event.issue.number }}
      prTitle: ${{ github.event.issue.title }}
      commentBody: ${{ github.event.comment.body }}
      commentAuthor: ${{ github.event.comment.user.login }}
      prBranch: ${{ needs.get-pr-branch.outputs.branch }}
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      SF_AUTH_URL: ${{ secrets.SF_AUTH_URL }}

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
            base=$(jq -r '.base.ref' <<< "$pr_json")

            if [[ "$base" != "__BASE_BRANCH__" ]]; then
              continue
            fi

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
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      SF_AUTH_URL: ${{ secrets.SF_AUTH_URL }}

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
    with:
      baseBranch: __BASE_BRANCH__
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      SF_AUTH_URL: ${{ secrets.SF_AUTH_URL }}
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
ensure_label "claude-plan" "1d76db" "Ask Claude to draft an implementation plan only"
ensure_label "claude-plan-in-progress" "fbca04" "Claude planning workflow is currently running"
ensure_label "claude-plan-ready" "0e8a16" "Claude posted an implementation plan"
ensure_label "claude-plan-failed" "b60205" "Claude planning workflow failed"
ensure_label "claude-awaiting-production" "fbca04" "A matching fix has merged but has not reached production"

open_install_pr

if [[ "$INSTALL_MODE" == "pr" ]]; then
  echo "Done. Workflow install PR opened or updated for $REPO."
else
  echo "Done. Workflows installed in $REPO/.github/workflows/"
fi
echo ""
echo "Required secret — set per repo (Settings → Secrets → Actions):"
echo "  SF_AUTH_URL   — force://PlatformCLI::<token>@yourorg.my.salesforce.com"
echo ""
echo "  CLAUDE_CODE_OAUTH_TOKEN should be set once at the GitHub org level"
echo "  (Org Settings → Secrets → Actions) and granted to this repo."
echo "  If not using an org, set it per repo as well."
echo ""
if [[ "$INSTALL_MODE" == "pr" ]]; then
  echo "After merging the install PR, run the init workflow once to generate CLAUDE.md:"
else
  echo "Then run the init workflow once to generate CLAUDE.md:"
fi
echo "  gh workflow run init-repo.yml --repo $REPO"
