#!/usr/bin/env bash
# One-time GCP setup for Gmail Pub/Sub → Cloud Run pipeline.
#
# Usage: ./scripts/setup-gcp.sh <gcp-project-id> <gmail-address>
#
# Prerequisites:
#   - gcloud CLI installed and authenticated
#   - Gmail API enabled in GCP Console
#   - Cloud Run API enabled

set -euo pipefail

PROJECT="${1:?Usage: $0 <gcp-project-id> <gmail-address>}"
GMAIL="${2:?Provide Gmail address}"
TOPIC="sf-errors"
SUBSCRIPTION="sf-errors-push"
SERVICE_NAME="llm-sfdc-gh"
REGION="us-central1"

echo "Setting up GCP project: $PROJECT"
gcloud config set project "$PROJECT"

# Enable required APIs
echo "Enabling APIs..."
gcloud services enable gmail.googleapis.com pubsub.googleapis.com run.googleapis.com secretmanager.googleapis.com

# Create Pub/Sub topic
echo "Creating Pub/Sub topic..."
gcloud pubsub topics create "$TOPIC" 2>/dev/null || echo "Topic already exists"

# Grant Gmail permission to publish to the topic
echo "Granting Gmail publish permission..."
gcloud pubsub topics add-iam-policy-binding "$TOPIC" \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher"

echo ""
echo "✅ GCP setup complete."
echo ""
echo "Next steps:"
echo "  1. Deploy Cloud Run: gcloud run deploy $SERVICE_NAME --source . --region $REGION"
echo "  2. Get the Cloud Run URL, then create a Pub/Sub push subscription:"
echo "     gcloud pubsub subscriptions create $SUBSCRIPTION \\"
echo "       --topic=$TOPIC \\"
echo "       --push-endpoint=https://<your-cloud-run-url>/webhooks/gmail \\"
echo "       --push-auth-service-account=<your-service-account>@$PROJECT.iam.gserviceaccount.com"
echo ""
echo "  3. Call Gmail watch() to start push notifications:"
echo "     npm run renew-watch"
