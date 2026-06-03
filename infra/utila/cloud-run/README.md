# Utila Co-Signer on Cloud Run

This folder is operator scaffolding for hosting a Utila external co-signer on
Google Cloud Run. It does not define an SDP-owned co-signer image, does not add
Utila as a selectable SDP signing provider, and does not change the default
self-hosted compose stack.

Use a Utila- or operator-supplied co-signer runtime. Replace every placeholder in
`service.template.yaml` with the image, command, environment variables, and
Secret Manager references required by that runtime.

## What this enables

This scaffold lets you host the co-signer service before Utila is part of the
default self-hosted SDP stack:

- Cloud Run hosts the operator-supplied co-signer image.
- Secret Manager stores provider config, private key material, and a runtime
  authentication token for SDP-to-co-signer calls.
- A dedicated runtime service account can read only those secrets.
- The deploy script prints a Cloud Run URL that your own SDP Utila integration
  can call once the integration wiring exists.

The co-signer remains an external service. SDP self-hosted compose stays focused
on the API, web, docs, database, cache, and migrations.

## Cloud layout

Create one Cloud Run service per environment:

- Separate GCP projects or folders for development, staging, and production.
- A dedicated runtime service account for each co-signer service.
- Secret Manager entries scoped to the matching environment.
- Separate Utila vaults, policies, keys, or API credentials for each
  environment.

Keep the co-signer outside `infra/self-hosted/compose.yml`. The compose stack
runs SDP; the co-signer is a provider-specific operational service.

## Secrets

Store all co-signer configuration and key material in Secret Manager. Do not
commit secrets to this repo and do not add them to the self-hosted `.env` file
unless a later signer integration documents an SDP API variable.

Typical secret categories:

- Provider API credentials.
- Co-signer private key material or encrypted key material.
- Runtime authentication token shared with your SDP Utila integration.
- Webhook or callback verification secrets.
- Optional provider policy configuration.

Grant the Cloud Run runtime service account `roles/secretmanager.secretAccessor`
only on the secrets required by that environment.

Pin private key secret versions in Cloud Run revisions instead of using
`latest`. Rotate by deploying a new revision that points at the new version, then
shift traffic after validation.

## Ingress and IAM

Choose ingress based on how the Utila co-signer runtime communicates:

- If the runtime only polls Utila or makes outbound calls, keep ingress private
  or disabled where the runtime supports it.
- If Utila must call the service over HTTP, allow only the required ingress path
  and use Cloud Run invoker IAM, an HTTPS load balancer, or another supported
  authentication layer.
- Avoid `allUsers` invoker unless the provider flow requires a public callback
  and request verification is enforced by the co-signer runtime.

## Scaling

Use `minScale: 1` for production if missed callbacks, slow cold starts, or key
availability would block transaction signing. Scale to zero is acceptable for
development and low-availability environments when cold starts are understood.

Set a conservative `maxScale` until the provider rate limits and signing policy
limits are known.

## Logging and alerts

Route Cloud Run logs to your normal observability stack. Alert on:

- Failed signing or co-signing attempts.
- Authentication or request verification failures.
- Container restarts and crash loops.
- Secret access failures.
- Stale key material, expired certificates, or policy drift.

Avoid logging private key material, provider tokens, full unsigned transaction
payloads, or customer-identifying metadata.

## Key rotation

Plan key rotation before production:

1. Add new provider credentials or key material in Secret Manager.
2. Deploy a new Cloud Run revision that can read the new secret version.
3. Confirm Utila policies accept the new co-signer identity.
4. Shift traffic to the new revision.
5. Revoke or disable the old credential after validation.

Keep rollback steps documented for each environment.

## Deploy sketch

The exact command depends on the Utila co-signer runtime. A typical Cloud Run
setup looks like:

```bash
gcloud config set project YOUR_GCP_PROJECT_ID

gcloud iam service-accounts create utila-cosigner-runtime \
  --display-name="Utila co-signer runtime"

gcloud secrets create utila-cosigner-config --replication-policy=automatic
gcloud secrets versions add utila-cosigner-config --data-file=./config.json

gcloud secrets create utila-cosigner-private-key --replication-policy=automatic
gcloud secrets versions add utila-cosigner-private-key --data-file=./private-key.txt

gcloud secrets create utila-cosigner-auth-token --replication-policy=automatic
gcloud secrets versions add utila-cosigner-auth-token --data-file=./auth-token.txt

gcloud secrets add-iam-policy-binding utila-cosigner-config \
  --member=serviceAccount:utila-cosigner-runtime@YOUR_GCP_PROJECT_ID.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor

gcloud secrets add-iam-policy-binding utila-cosigner-private-key \
  --member=serviceAccount:utila-cosigner-runtime@YOUR_GCP_PROJECT_ID.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor

gcloud secrets add-iam-policy-binding utila-cosigner-auth-token \
  --member=serviceAccount:utila-cosigner-runtime@YOUR_GCP_PROJECT_ID.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor

gcloud run services replace rendered.service.yaml --region YOUR_REGION
```

Before production, render or replace the template placeholders, verify
ingress/IAM, and confirm the co-signer has environment-specific Utila policy
approval.

For the scripted path:

```bash
cp infra/utila/cloud-run/.env.example infra/utila/cloud-run/.env.local
$EDITOR infra/utila/cloud-run/.env.local
infra/utila/cloud-run/deploy.sh infra/utila/cloud-run/.env.local
```

`deploy.sh` creates the runtime service account when needed, creates the listed
Secret Manager secrets when missing, optionally adds new secret versions from the
files in `.env.local`, grants the service account secret access, renders
`service.template.yaml`, applies it to Cloud Run, and prints the service URL.
It also syncs public invoker access with `COSIGNER_ALLOW_UNAUTHENTICATED`,
removing any existing `allUsers` invoker binding when the flag is `false`.

Set `COSIGNER_ALLOW_UNAUTHENTICATED=true` only when the runtime must be
reachable without Cloud Run IAM. In that mode the co-signer runtime must verify
each request, for example with the `COSIGNER_AUTH_TOKEN` secret. Re-run the
script with `COSIGNER_ALLOW_UNAUTHENTICATED=false` to lock down a service that
was previously public.

If your co-signer image expects different environment variable names, edit
`service.template.yaml` before deploying. Keep the Cloud Run service account,
ingress, scaling, and secret-version pinning pattern intact.

## SDP integration boundary

This scaffold is a prerequisite for the Utila signer integration. The signer
integration should later add the SDP API configuration and runtime wiring that
lets SDP talk to Utila. Until that lands, this folder is hosting guidance only.

For a custom Utila integration, point the integration at the deployed Cloud Run
URL and use a token or IAM strategy that matches the co-signer runtime. Keep the
runtime URL, auth token, and provider-specific variables out of
`infra/self-hosted/.env.example` until the Utila signer integration owns those
fields.
