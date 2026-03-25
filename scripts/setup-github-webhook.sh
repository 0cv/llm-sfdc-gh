#!/usr/bin/env bash
# Registers a GitHub webhook on a repo to send PR/issue events to Cloud Run.
#
# Usage: ./scripts/setup-github-webhook.sh owner/repo
#
# Reads GITHUB_WEBHOOK_SECRET from .env automatically.
# Looks up the Cloud Run URL from gcloud automatically.
# Requires: gh CLI authenticated, gcloud authenticated

set -euo pipefail

REPO="${1:?Usage: $0 owner/repo}"
REGION="${2:-us-central1}"
SERVICE="llm-sfdc-gh"

# Read secret from .env
SECRET=$(grep -E "^GITHUB_WEBHOOK_SECRET=" .env | cut -d= -f2- | tr -d '\r')
if [[ -z "$SECRET" ]]; then
  echo "Error: GITHUB_WEBHOOK_SECRET not found in .env"
  exit 1
fi

# Look up Cloud Run URL
echo "Looking up Cloud Run URL for $SERVICE..."
CLOUD_RUN_URL=$(gcloud run services describe "$SERVICE" \
  --region "$REGION" \
  --format="value(status.url)")

if [[ -z "$CLOUD_RUN_URL" ]]; then
  echo "Error: Could not find Cloud Run service '$SERVICE' in region $REGION"
  exit 1
fi

WEBHOOK_URL="${CLOUD_RUN_URL}/webhooks/github"
echo "Webhook URL: $WEBHOOK_URL"

gh api "repos/${REPO}/hooks" \
  --method POST \
  -f "config[url]=${WEBHOOK_URL}" \
  -f "config[content_type]=json" \
  -f "config[secret]=${SECRET}" \
  -f "events[]=issue_comment" \
  -f "events[]=pull_request_review" \
  -f "events[]=pull_request_review_comment" \
  -f "events[]=issues" \
  -F "active=true"

echo "✅ Webhook created for ${REPO} → ${WEBHOOK_URL}"
