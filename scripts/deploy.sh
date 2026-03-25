#!/usr/bin/env bash
# Deploy or update the Cloud Run service, then wire up the Pub/Sub push subscription.
# Reads Cloud Run env vars from .env automatically.
#
# Usage: ./scripts/deploy.sh [gcp-project-id] [region]
#
# Defaults:
#   project: current gcloud project
#   region:  us-central1

set -euo pipefail

PROJECT="${1:-$(gcloud config get-value project)}"
REGION="${2:-us-central1}"
SERVICE="llm-sfdc-gh"
TOPIC="sf-errors"
SUBSCRIPTION="sf-errors-push"
ENV_FILE=".env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: .env file not found"
  exit 1
fi

# Extract only the Cloud Run variables from .env
CLOUD_RUN_VARS=(
  GMAIL_CLIENT_ID
  GMAIL_CLIENT_SECRET
  GMAIL_REFRESH_TOKEN
  GMAIL_PUBSUB_TOPIC
  GITHUB_TOKEN
  ADMIN_SECRET
  ANTHROPIC_AUTH_TOKEN
)

env_string=""
for var in "${CLOUD_RUN_VARS[@]}"; do
  value=$(grep -E "^${var}=" "$ENV_FILE" | cut -d= -f2- | tr -d '\r')
  if [[ -z "$value" || "$value" == your-* || "$value" == ghp_... ]]; then
    echo "Warning: $var is not set or still has placeholder value"
    continue
  fi
  env_string+="${var}=${value},"
done

# Remove trailing comma
env_string="${env_string%,}"

# ── Step 1: Deploy Cloud Run ──────────────────────────────────────────
echo "Deploying $SERVICE to Cloud Run ($PROJECT / $REGION)..."
echo ""

gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --project "$PROJECT" \
  --set-env-vars "$env_string" \
  --allow-unauthenticated

CLOUD_RUN_URL=$(gcloud run services describe "$SERVICE" \
  --region "$REGION" \
  --project "$PROJECT" \
  --format="value(status.url)")

echo ""
echo "✅ Cloud Run deployed: $CLOUD_RUN_URL"

# ── Step 2: Create or update Pub/Sub push subscription ───────────────
PUSH_ENDPOINT="${CLOUD_RUN_URL}/webhooks/gmail"

if gcloud pubsub subscriptions describe "$SUBSCRIPTION" --project "$PROJECT" &>/dev/null; then
  echo "Updating Pub/Sub push subscription → $PUSH_ENDPOINT"
  gcloud pubsub subscriptions modify-push-config "$SUBSCRIPTION" \
    --project "$PROJECT" \
    --push-endpoint "$PUSH_ENDPOINT"
else
  echo "Creating Pub/Sub push subscription → $PUSH_ENDPOINT"
  gcloud pubsub subscriptions create "$SUBSCRIPTION" \
    --project "$PROJECT" \
    --topic "$TOPIC" \
    --push-endpoint "$PUSH_ENDPOINT"
fi

echo ""
echo "✅ Pub/Sub subscription wired to $PUSH_ENDPOINT"
# ── Step 3: Create or update Cloud Scheduler job for daily watch renewal ──
ADMIN_SECRET=$(grep -E "^ADMIN_SECRET=" "$ENV_FILE" | cut -d= -f2- | tr -d '\r')
SCHEDULER_JOB="renew-gmail-watch"

if gcloud scheduler jobs describe "$SCHEDULER_JOB" --location "$REGION" --project "$PROJECT" &>/dev/null; then
  echo "Updating Cloud Scheduler job..."
  gcloud scheduler jobs update http "$SCHEDULER_JOB" \
    --location "$REGION" \
    --project "$PROJECT" \
    --schedule "0 6 * * *" \
    --uri "${CLOUD_RUN_URL}/admin/renew-watch" \
    --http-method POST \
    --update-headers "Authorization=Bearer ${ADMIN_SECRET}"
else
  echo "Creating Cloud Scheduler job (daily at 06:00 UTC)..."
  gcloud scheduler jobs create http "$SCHEDULER_JOB" \
    --location "$REGION" \
    --project "$PROJECT" \
    --schedule "0 6 * * *" \
    --uri "${CLOUD_RUN_URL}/admin/renew-watch" \
    --http-method POST \
    --headers "Authorization=Bearer ${ADMIN_SECRET}"
fi

echo "✅ Cloud Scheduler job set: daily Gmail watch renewal"
echo ""
echo "Done. Run 'npm run renew-watch' once to start the initial Gmail watch."
