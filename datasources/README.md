# GCP Cloud Monitoring (stackdriver) datasource for Grafana Cloud

`gcm-sdp.json` provisions a Grafana Cloud datasource of type `stackdriver` (uid `sdp-gcm`)
pointing at GCP project `solana-developer-platform`. It powers the generic
`sdp-cloud-run-service-failing` alert rule, which alerts on the GCP log-based metric
`logging.googleapis.com/user/sdp_cloud_run_service_failures`.

## Status

- Service account `grafana-gcm-reader@solana-developer-platform.iam.gserviceaccount.com` — CREATED.
- Log-based metric `sdp_cloud_run_service_failures` — CREATED (see `apply-log-metric.sh`).
- IAM role `roles/monitoring.viewer` for the SA — **GRANTED** by an SDP owner. SA key stored in
  Doppler as `GCM_GRAFANA_SA_KEY` (full JSON) and `GCM_GRAFANA_SA_PRIVATE_KEY` (PEM private_key).
- Datasource `sdp-gcm` — **CREATED** in Grafana Cloud; health check returns OK.
- Alert rule `sdp-cloud-run-service-failing` + dashboard `sdp-gcp` ("SDP — GCP Cloud Run") —
  **PUSHED** to Grafana and evaluating cleanly.

> Grafana Cloud runs the Cloud Monitoring (stackdriver) plugin v12.5.x, which uses the
> `timeSeriesList` query type with the metric type expressed in `filters`
> (`["metric.type", "=", "<type>"]`). The legacy `metricQuery`/`metricType` shape is not parsed
> by this plugin version; the alert rule and dashboard use `timeSeriesList`.

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

# 3. Create the datasource in Grafana (injects ${GCM_GRAFANA_SA_PRIVATE_KEY} via jq so the
#    multiline PEM is JSON-escaped correctly). Use PUT by uid if it already exists.
doppler run --project solana-developer-platform --config prd -- bash -c '
  payload=$(jq --arg pk "$GCM_GRAFANA_SA_PRIVATE_KEY" ".secureJsonData.privateKey = \$pk" datasources/gcm-sdp.json)
  curl -fsS -X POST "$GRAFANA_API_URL/api/datasources" \
    -H "Authorization: Bearer $GRAFANA_API_TOKEN" \
    -H "Content-Type: application/json" --data "$payload"'

# 4. Test the datasource (health), then push alert rules
doppler run --project solana-developer-platform --config prd -- bash scripts/grafana-sync.sh
```

The SA must hold `roles/monitoring.viewer` and nothing else.
