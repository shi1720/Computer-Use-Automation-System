#!/usr/bin/env bash
# Deploy a dedicated service and clean Hosting site in a billing-enabled project.
set -euo pipefail
: "${GCP_PROJECT:?Set GCP_PROJECT to your billing-enabled Firebase project}"
REGION="${SWIVEL_REGION:-us-central1}"
SERVICE="${SWIVEL_SERVICE:-swivel}"
IMAGE="gcr.io/${GCP_PROJECT}/${SERVICE}"
npm ci
npm run typecheck
npm test
# No API key is included in the public demo image.
gcloud builds submit --tag "$IMAGE" --project "$GCP_PROJECT" --quiet
gcloud run deploy "$SERVICE" --image "$IMAGE" --project "$GCP_PROJECT" --region "$REGION" \
  --allow-unauthenticated --memory=2Gi --cpu=1 --max-instances=1 --min-instances=0 \
  --concurrency=20 --timeout=900 --no-cpu-throttling --quiet
SERVICE_URL=$(gcloud run services describe "$SERVICE" --project "$GCP_PROJECT" --region "$REGION" --format='value(status.url)')
gcloud run services update "$SERVICE" --project "$GCP_PROJECT" --region "$REGION" \
  --update-env-vars "SWIVEL_PUBLIC_RUN_URL=$SERVICE_URL" --quiet
npx firebase-tools deploy --only hosting --project "$GCP_PROJECT" --non-interactive
