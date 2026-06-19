# GCP Cloud Monitoring (stackdriver) datasource for Grafana Cloud

`gcm-sdp.json` provisions a Grafana Cloud datasource of type `stackdriver` (uid `sdp-gcm`)
pointing at GCP project `solana-developer-platform`. It powers the generic
`sdp-cloud-run-service-failing` alert rule, which alerts on the GCP log-based metric
`logging.googleapis.com/user/sdp_cloud_run_service_failures`.

## Status

- Service account `grafana-gcm-reader@solana-developer-platform.iam.gserviceaccount.com` — CREATED.
- Log-based metric `sdp_cloud_run_service_failures` — CREATED (see `apply-log-metric.sh`).
- IAM role `roles/monitoring.viewer` for the SA — **NOT GRANTED** (the operator who set this up
  lacks `resourcemanager.projects.setIamPolicy` on the project). A project admin must grant it.
- Datasource + alert rule — authored in the repo but **NOT pushed** to Grafana (would error
  without a working datasource).

## Finishing steps (requires a principal with setIamPolicy + Doppler write)

```bash
# 1. Grant the SA monitoring.viewer ONLY
gcloud projects add-iam-policy-binding solana-developer-platform \
  --member "serviceAccount:grafana-gcm-reader@solana-developer-platform.iam.gserviceaccount.com" \
  --role "roles/monitoring.viewer" --condition None

# 2. Create a JSON key, store the FULL key JSON in Doppler (never commit it)
gcloud iam service-accounts keys create /tmp/gcm-key.json \
  --iam-account grafana-gcm-reader@solana-developer-platform.iam.gserviceaccount.com
doppler secrets set GCM_GRAFANA_SA_KEY --project solana-developer-platform --config prd < /tmp/gcm-key.json
# also expose just the private_key PEM for datasource secureJsonData expansion:
doppler secrets set GCM_GRAFANA_SA_PRIVATE_KEY \
  --project solana-developer-platform --config prd \
  -- "$(jq -r '.private_key' /tmp/gcm-key.json)"
shred -u /tmp/gcm-key.json   # or rm

# 3. Create the datasource in Grafana (expands ${GCM_GRAFANA_SA_PRIVATE_KEY})
doppler run --project solana-developer-platform --config prd -- bash -c '
  payload=$(envsubst < datasources/gcm-sdp.json)
  curl -fsS -X POST "$GRAFANA_API_URL/api/datasources" \
    -H "Authorization: Bearer $GRAFANA_API_TOKEN" \
    -H "Content-Type: application/json" --data "$payload"'

# 4. Test the datasource (health), then push alert rules
doppler run --project solana-developer-platform --config prd -- bash scripts/grafana-sync.sh
```

The SA must hold `roles/monitoring.viewer` and nothing else.
