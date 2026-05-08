# Cloudflare Resource IDs

⚠️ **Maintainers Only** — This guide covers Cloudflare resource configuration for the SDP API.

---

## Why This Document Exists

The `apps/sdp-api/wrangler.toml` file contains **placeholders** for Cloudflare resource IDs (Hyperdrive and KV namespaces) instead of real IDs. This is intentional:

- **For public repository safety** — Real resource IDs would leak internal infrastructure identifiers
- **For flexibility** — Different deployments (dev, staging, production) can use different resource IDs

Since the real IDs cannot live in git, they are:

1. **Stored securely in Doppler** — Each environment has its own config
2. **Injected at deploy time** — CI/CD replaces placeholders with real values before deploying
3. **Never exposed in logs** — Doppler redacts secrets from output

---

## Resource ID Mapping

### Hyperdrive (PostgreSQL Connection Pool)

The `wrangler.toml` defines a Hyperdrive binding:

```toml
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "your_dev_hyperdrive_id"  # ← Placeholder
```

The real ID (stored in Doppler) is injected during CI/CD.

### KV Namespaces

Four KV namespaces are used:

| Binding | Purpose | Placeholder (git) |
|---|---|---|
| `SDP_API_KEYS` | API key storage/caching | `your_dev_api_keys_kv_id` |
| `SDP_RATE_LIMITS` | Rate limit tracking | `your_dev_rate_limits_kv_id` |
| `SDP_CACHE` | General caching | `your_dev_cache_kv_id` |
| `SDP_SESSIONS` | Session storage | `your_dev_sessions_kv_id` |

**Real IDs**: Stored only in Doppler (`WRANGLER_SDP_*_ID` environment variables), not in git.

---

## Doppler Configuration

Each environment in Doppler must define these variables:

### For `dev` config:

```
WRANGLER_HYPERDRIVE_ID=<dev-hyperdrive-id>
WRANGLER_SDP_API_KEYS_ID=<dev-api-keys-id>
WRANGLER_SDP_RATE_LIMITS_ID=<dev-rate-limits-id>
WRANGLER_SDP_CACHE_ID=<dev-cache-id>
WRANGLER_SDP_SESSIONS_ID=<dev-sessions-id>
```

### For `prd` config:

```
WRANGLER_HYPERDRIVE_ID=<prd-hyperdrive-id>
WRANGLER_SDP_API_KEYS_ID=<prd-api-keys-id>
WRANGLER_SDP_RATE_LIMITS_ID=<prd-rate-limits-id>
WRANGLER_SDP_CACHE_ID=<prd-cache-id>
WRANGLER_SDP_SESSIONS_ID=<prd-sessions-id>
```

**Note**: Real IDs are stored only in Doppler, not in this document.

---

## Injection Mechanism

### How It Works

During CI/CD deployment, the `.github/workflows/deploy-sdp-api.yml` workflow:

1. **Validates** that all required `WRANGLER_*` variables exist in Doppler
2. **Calls** `scripts/render-wrangler-config.mjs`
3. **Replaces** placeholders in `wrangler.toml` with real values from Doppler
4. **Deploys** with `wrangler deploy --env <dev|production>`

### The Injection Script

**Location**: `scripts/render-wrangler-config.mjs`

**Input**: Environment variables from Doppler
**Output**: Modified `wrangler.toml` (in-memory, not committed)

**Example**:

```javascript
// Before injection (git-tracked):
[env.dev.hyperdrive]
binding = "HYPERDRIVE"
id = "your_dev_hyperdrive_id"

// After injection (at deploy time):
[env.dev.hyperdrive]
binding = "HYPERDRIVE"
id = "<real-hyperdrive-id-from-doppler>"
```

### Validation

The script validates:
- All 5 required variables are present
- Target environment section exists in `wrangler.toml`
- Placeholders are found and replaced (fails if placeholder is missing)

---

## CI/CD Deployment Steps

In the `deploy-sdp-api.yml` workflow:

```yaml
- name: Inject Cloudflare resource IDs
  env:
    DOPPLER_TOKEN: ${{ secrets.DOPPLER_TOKEN }}
  run: |
    doppler run --config ${DOPPLER_CONFIG_NAME} -- \
      node scripts/render-wrangler-config.mjs
```

This step:
1. Reads secrets from Doppler (via `DOPPLER_TOKEN`)
2. Extracts `WRANGLER_*` variables
3. Modifies `wrangler.toml` in the running container
4. Subsequent `wrangler deploy` uses the injected IDs

---

## Local Development

### Option A: Use Doppler (Team Members)

If you have team Doppler access:

```bash
doppler login
doppler run --config dev -- pnpm dev
```

Doppler automatically injects all secrets, including `WRANGLER_*` variables.

### Option B: Manual Configuration (External Contributors)

If you don't have Doppler access, you can set environment variables manually:

```bash
export WRANGLER_HYPERDRIVE_ID=<local-hyperdrive-id>
export WRANGLER_SDP_API_KEYS_ID=<local-kv-id>
export WRANGLER_SDP_RATE_LIMITS_ID=<local-kv-id>
export WRANGLER_SDP_CACHE_ID=<local-kv-id>
export WRANGLER_SDP_SESSIONS_ID=<local-kv-id>

pnpm dev
```

Or create a `.env.local` file in `apps/sdp-api/`:

```bash
WRANGLER_HYPERDRIVE_ID=your_local_id
WRANGLER_SDP_API_KEYS_ID=your_local_id
# ... etc
```

Then:

```bash
source apps/sdp-api/.env.local
pnpm dev
```

### Wrangler Local Bindings

Wrangler provides local Hyperdrive and KV bindings during `wrangler dev`. These use the configuration in `wrangler.toml`:

```toml
# Local (development) bindings
[[hyperdrive]]
binding = "HYPERDRIVE"
id = "00000000000000000000000000000000"  # Placeholder for local
localConnectionString = "postgresql://sdp:sdp@127.0.0.1:5432/sdp"

[[kv_namespaces]]
binding = "SDP_API_KEYS"
id = "local-api-keys"  # In-memory during `wrangler dev`
```

When running `pnpm dev`, Wrangler uses `localConnectionString` (for Hyperdrive) and in-memory KV. No real Cloudflare resource IDs are needed.

---

## Troubleshooting

### "WRANGLER_HYPERDRIVE_ID not set in Doppler"

**Cause**: The variable is missing from the Doppler config.

**Solution**:
1. Go to Doppler dashboard
2. Select the target config (dev or prd)
3. Add the missing `WRANGLER_*` variable
4. Retry the deployment

### "Placeholder 'your_dev_hyperdrive_id' not found in wrangler.toml"

**Cause**: The script expected the placeholder but it's not in the file (e.g., it was already replaced).

**Solution**:
1. Check `wrangler.toml` — are placeholders present?
2. If not, restore them from git: `git checkout apps/sdp-api/wrangler.toml`
3. Retry the deployment

### "Injection script fails silently"

**Cause**: Script error or missing environment variables.

**Solution**:
1. Run the script manually with debug output:
   ```bash
   node scripts/render-wrangler-config.mjs
   ```
2. Check for errors in the output
3. Verify all `WRANGLER_*` variables are exported:
   ```bash
   env | grep WRANGLER
   ```

### Local development: KV not persisting between requests

**Cause**: Wrangler's local KV is in-memory and resets on restart.

**Solution**: This is expected. For persistent local KV, use Doppler or manually set up Cloudflare KV miniflare. Production uses persistent Cloudflare KV.

---

## Reference

- **Cloudflare Hyperdrive**: https://developers.cloudflare.com/hyperdrive/
- **Cloudflare KV**: https://developers.cloudflare.com/kv/
- **Wrangler CLI**: https://developers.cloudflare.com/workers/wrangler/
- **Injection script**: `scripts/render-wrangler-config.mjs`
- **Deploy workflow**: `.github/workflows/deploy-sdp-api.yml`
- **Doppler setup**: [`docs/ops/doppler-secrets.md`](doppler-secrets.md)
