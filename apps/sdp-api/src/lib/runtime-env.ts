import type { Env } from "@/types/env";

const PROCESS_ENV_FALLBACK_KEYS = [
  "ENVIRONMENT",
  "API_VERSION",
  "SDP_DEPLOYMENT_MODE",
  // Selects the KV / DB runtime branch. Without this, code outside the
  // server.ts hardcode (scripts, tests) sees SDP_RUNTIME undefined and
  // defaults to Cloudflare mode even when the process is plainly Node.
  "SDP_RUNTIME",
  // Connection strings populated from process.env when bindings aren't set
  // — pg uses DATABASE_URL, RedisKVStore uses REDIS_URL.
  "DATABASE_URL",
  "REDIS_URL",
  "API_KEY_PEPPER",
  "CUSTODY_ENCRYPTION_KEY",
  "SENTRY_DSN",
  "SENTRY_TRACES_SAMPLE_RATE",
  "EMAIL_PROVIDER",
  "EMAIL_FROM",
  "RESEND_API_KEY",
  "FRONTEND_URL",
  "CLERK_ISSUER",
  "CLERK_JWKS_URL",
  "CLERK_AUDIENCE",
  "CLERK_SECRET_KEY",
  "CLERK_API_URL",
  "CLERK_WEBHOOK_SECRET",
  "ALLOWLIST_ADMIN_KEY",
  "ALLOWLIST_ADMIN_ORG_ID",
  "SOLANA_RPC_URL",
  "SOLANA_RPC_DEFAULT_PROVIDER",
  "SOLANA_RPC_TRITON_URL",
  "SOLANA_RPC_TRITON_API_KEY",
  "SOLANA_RPC_HELIUS_URL",
  "SOLANA_RPC_HELIUS_API_KEY",
  "SOLANA_RPC_ALCHEMY_URL",
  "SOLANA_RPC_ALCHEMY_API_KEY",
  "SOLANA_RPC_QUICKNODE_URL",
  "SOLANA_RPC_QUICKNODE_API_KEY",
  "SOLANA_NETWORK",
  "CUSTODY_PRIVATE_KEY",
  "SOLANA_MOCK",
  "RUN_INTEGRATION_TESTS",
  "SIGNING_PROVIDER",
  "FEE_PAYER_PRIVATE_KEY",
  "FIREBLOCKS_API_KEY",
  "FIREBLOCKS_API_SECRET",
  "FIREBLOCKS_VAULT_ID",
  "FIREBLOCKS_ASSET_ID",
  "FIREBLOCKS_API_BASE_URL",
  "PRIVY_APP_ID",
  "PRIVY_APP_SECRET",
  "PRIVY_WALLET_ID",
  "PRIVY_API_BASE_URL",
  "PRIVY_REQUEST_DELAY_MS",
  "COINBASE_CDP_API_KEY_ID",
  "COINBASE_CDP_API_KEY_SECRET",
  "COINBASE_CDP_WALLET_SECRET",
  "COINBASE_CDP_API_BASE_URL",
  "COINBASE_CDP_NETWORK",
  "COINBASE_CDP_WALLET_ID",
  "COINBASE_CDP_ACCOUNT_NAMESPACE",
  "PARA_API_KEY",
  "PARA_API_BASE_URL",
  "PARA_REQUEST_DELAY_MS",
  "PARA_WALLET_ID",
  "TURNKEY_API_PUBLIC_KEY",
  "TURNKEY_API_PRIVATE_KEY",
  "TURNKEY_ORGANIZATION_ID",
  "TURNKEY_API_BASE_URL",
  "TURNKEY_REQUEST_DELAY_MS",
  "TURNKEY_PRIVATE_KEY_ID",
  "TURNKEY_PUBLIC_KEY",
  "DFNS_AUTH_TOKEN",
  "DFNS_CREDENTIAL_ID",
  "DFNS_PRIVATE_KEY",
  "DFNS_API_BASE_URL",
  "DFNS_WALLET_ID",
  "ANCHORAGE_API_KEY",
  "ANCHORAGE_API_BASE_URL",
  "UTILA_SERVICE_ACCOUNT_EMAIL",
  "UTILA_SERVICE_ACCOUNT_PRIVATE_KEY",
  "UTILA_VAULT_ID",
  "UTILA_WALLET_ID",
  "UTILA_NETWORK",
  "UTILA_API_BASE_URL",
  "UTILA_POLL_INTERVAL_MS",
  "UTILA_MAX_POLL_ATTEMPTS",
  "UTILA_DESIGNATED_SIGNERS",
  "FEE_PAYMENT_PROVIDER",
  "KORA_RPC_URL",
  "KORA_API_KEY",
  "KORA_TIMEOUT_MS",
  "MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL",
  "MAGICBLOCK_PRIVATE_PAYMENTS_AUTH_TOKEN",
  "PAYMENTS_RECURRING_ENABLED",
  "PAYMENTS_RECURRING_COLLECTION_ENABLED",
  "PAYMENTS_RECURRING_COLLECTION_BATCH_SIZE",
  "PAYMENTS_RECURRING_COLLECTION_RETRY_AFTER_MINUTES",
  "MOONPAY_API_KEY",
  "MOONPAY_SECRET_KEY",
  "MOONPAY_ONRAMP_URL",
  "MOONPAY_OFFRAMP_URL",
  "RANGE_API_KEY",
  "RANGE_API_BASE_URL",
  "ELLIPTIC_API_TOKEN",
  "ELLIPTIC_API_KEY",
  "ELLIPTIC_API_SECRET",
  "ELLIPTIC_API_BASE_URL",
  "TRM_API_KEY",
  "TRM_API_BASE_URL",
  "CHAINALYSIS_API_KEY",
  "CHAINALYSIS_API_BASE_URL",
  "LIGHTSPARK_GRID_CLIENT_ID",
  "LIGHTSPARK_GRID_CLIENT_SECRET",
  "LIGHTSPARK_GRID_API_BASE_URL",
  "BVNK_HAWK_AUTH_ID",
  "BVNK_HAWK_SECRET_KEY",
  "BVNK_WALLET_ID",
  "BVNK_WEBHOOK_SECRET",
  "BVNK_API_BASE_URL",
  "BVNK_SANDBOX_HAWK_AUTH_ID",
  "BVNK_SANDBOX_HAWK_SECRET_KEY",
  "BVNK_SANDBOX_WALLET_ID",
  "BVNK_SANDBOX_WEBHOOK_SECRET",
  "DISABLE_CRON",
] as const satisfies readonly (keyof Env)[];

const fallbackKeys = new Set<string>(PROCESS_ENV_FALLBACK_KEYS);

export function registerFallbackKeys(...keys: string[]): void {
  for (const key of keys) {
    fallbackKeys.add(key);
  }
}

export type SdpDeploymentMode = "managed" | "self_hosted";

const VALID_DEPLOYMENT_MODES: ReadonlySet<string> = new Set<SdpDeploymentMode>([
  "managed",
  "self_hosted",
]);

const validatedDeploymentModes = new Map<string, SdpDeploymentMode>();

function resolveDeploymentMode(value: string | undefined): SdpDeploymentMode {
  if (value === undefined) {
    return "managed";
  }
  const cached = validatedDeploymentModes.get(value);
  if (cached !== undefined) {
    return cached;
  }
  if (!VALID_DEPLOYMENT_MODES.has(value)) {
    throw new Error(
      `Invalid SDP_DEPLOYMENT_MODE: "${value}". Expected "managed" or "self_hosted".`
    );
  }
  const resolved = value as SdpDeploymentMode;
  validatedDeploymentModes.set(value, resolved);
  return resolved;
}

export function getDeploymentMode(env: Pick<Env, "SDP_DEPLOYMENT_MODE">): SdpDeploymentMode {
  return resolveDeploymentMode(env.SDP_DEPLOYMENT_MODE);
}

export function isSelfHostedDeployment(env: Pick<Env, "SDP_DEPLOYMENT_MODE">): boolean {
  return resolveDeploymentMode(env.SDP_DEPLOYMENT_MODE) === "self_hosted";
}

export type SdpRuntime = "cloudflare" | "node";

const VALID_RUNTIMES: ReadonlySet<string> = new Set<SdpRuntime>(["cloudflare", "node"]);

const validatedRuntimes = new Map<string, SdpRuntime>();

function resolveRuntime(value: string | undefined): SdpRuntime {
  if (value === undefined) {
    return "cloudflare";
  }
  const cached = validatedRuntimes.get(value);
  if (cached !== undefined) {
    return cached;
  }
  if (!VALID_RUNTIMES.has(value)) {
    throw new Error(`Invalid SDP_RUNTIME: "${value}". Expected "cloudflare" or "node".`);
  }
  const resolved = value as SdpRuntime;
  validatedRuntimes.set(value, resolved);
  return resolved;
}

// Single read point for SDP_RUNTIME. Direct access to env.SDP_RUNTIME elsewhere
// risks a silent fallthrough when the value is undefined or misspelled — route
// every runtime branch through this helper.
export function getRuntime(env: Pick<Env, "SDP_RUNTIME">): SdpRuntime {
  return resolveRuntime(env.SDP_RUNTIME);
}

export function withProcessEnvFallback(bindings: Env): Env {
  if (typeof process === "undefined" || !process.env) {
    return bindings;
  }

  let merged: Env | null = null;
  const source = bindings as unknown as Record<string, unknown>;

  for (const key of fallbackKeys) {
    if (source[key] !== undefined) {
      continue;
    }

    const fallback = process.env[key];
    if (!fallback) {
      continue;
    }

    if (!merged) {
      merged = { ...bindings };
    }

    Object.assign(merged, { [key]: fallback });
  }

  return merged ?? bindings;
}
