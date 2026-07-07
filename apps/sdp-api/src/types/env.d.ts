/**
 * Cloudflare Worker Environment Bindings
 *
 * These types define the bindings available in the Worker runtime,
 * configured via wrangler.toml.
 */

import type { HyperdriveBinding } from "@/db";
import type { ClerkJwtPayload } from "@/lib/clerk-token";
import type { KVStoreSet } from "@/runtime/kv";
import type { ApiKeyEnvironment, CachedSession, OrganizationRpcProvider, Permission } from "@sdp/types";

export interface Env {
  // Hyperdrive database binding (Cloudflare runtime only)
  HYPERDRIVE?: HyperdriveBinding;

  // KV Namespaces (Cloudflare runtime only)
  SDP_API_KEYS?: KVNamespace;
  SDP_RATE_LIMITS?: KVNamespace;
  SDP_CACHE?: KVNamespace;
  SDP_SESSIONS?: KVNamespace;

  // Node runtime equivalents (Postgres + Redis via connection strings)
  DATABASE_URL?: string;
  REDIS_URL?: string;

  // Selects which runtime-specific code path to take.
  // "cloudflare" uses HYPERDRIVE + KVNamespace bindings above;
  // "node" uses DATABASE_URL + REDIS_URL.
  SDP_RUNTIME?: "cloudflare" | "node";

  // When the Node entrypoint runs with multiple replicas, scheduling the
  // reconciliation cron on every replica would fire the job N times per
  // tick. Setting this to "true" or "1" makes startCron a no-op so only
  // one designated replica drives the job. Ignored on Cloudflare (CF uses
  // a single scheduled handler per deployment).
  DISABLE_CRON?: string;

  // Environment variables
  ENVIRONMENT: "development" | "production";
  API_VERSION: string;

  // Public-facing origin of this API (e.g. "https://api.example.com"). When set,
  // it overrides the request-derived origin used to build the SDP-hosted token
  // metadata URL that gets burned into the on-chain MetadataPointer. Set this in
  // any environment fronted by a proxy that rewrites Host/scheme, so the URI
  // can't capture an internal, unreachable address. Falls back to the request
  // origin (correct on Cloudflare Workers) when unset.
  PUBLIC_API_ORIGIN?: string;

  // Deployment mode. "managed" (default) uses tier-based provider entitlements
  // synced from Clerk. "self_hosted" treats every configured provider as
  // entitled regardless of org tier, so the platform runs with whatever
  // provider env vars are present. Per-org providerOverrides still apply as
  // a disable-only mechanism.
  SDP_DEPLOYMENT_MODE?: "managed" | "self_hosted";

  // Credential secret store selection for BYO custody credentials.
  // Managed SDP should use GCP Secret Manager. Self-hosted deployments default
  // to encrypted DB storage and can also resolve provider credentials directly
  // from runtime env bindings.
  CREDENTIAL_SECRET_STORE_BACKEND?: "gcp_secret_manager" | "encrypted_db" | "runtime_env";
  GCP_SECRET_MANAGER_PROJECT_ID?: string;
  GCP_SECRET_MANAGER_SECRET_PREFIX?: string;
  GCP_SECRET_MANAGER_API_BASE_URL?: string;

  // Secrets (set via wrangler secret)
  API_KEY_PEPPER?: string;
  CUSTODY_ENCRYPTION_KEY?: string; // For encrypting org private keys in DB
  SENTRY_DSN?: string;
  SENTRY_TRACES_SAMPLE_RATE?: string;

  // Email configuration
  EMAIL_FROM?: string;
  RESEND_API_KEY?: string;
  FRONTEND_URL?: string;

  // Clerk configuration
  CLERK_ISSUER?: string;
  CLERK_JWKS_URL?: string;
  CLERK_AUDIENCE?: string;
  CLERK_SECRET_KEY?: string;
  CLERK_API_URL?: string;
  CLERK_WEBHOOK_SECRET?: string;

  // Allowlist configuration
  ALLOWLIST_ADMIN_KEY?: string;
  ALLOWLIST_ADMIN_ORG_ID?: string;

  // Solana configuration
  SOLANA_RPC_URL?: string;
  SOLANA_RPC_DEFAULT_PROVIDER?: OrganizationRpcProvider;
  SOLANA_RPC_TRITON_URL?: string;
  SOLANA_RPC_TRITON_API_KEY?: string;
  SOLANA_RPC_HELIUS_URL?: string;
  SOLANA_RPC_HELIUS_API_KEY?: string;
  SOLANA_RPC_ALCHEMY_URL?: string;
  SOLANA_RPC_ALCHEMY_API_KEY?: string;
  SOLANA_RPC_QUICKNODE_URL?: string;
  SOLANA_RPC_QUICKNODE_API_KEY?: string;
  SOLANA_NETWORK?: "devnet" | "mainnet-beta";
  CUSTODY_PRIVATE_KEY?: string;
  SOLANA_MOCK?: string;
  RUN_INTEGRATION_TESTS?: string;

  // Signing provider (custody backend via @solana/keychain)
  SIGNING_PROVIDER?:
  | "local"
  | "fireblocks"
  | "privy"
  | "coinbase_cdp"
  | "para"
  | "turnkey"
  | "dfns"
  | "anchorage"
  | "utila";
  FEE_PAYER_PRIVATE_KEY?: string;

  // Fireblocks configuration (@solana/keychain-fireblocks)
  FIREBLOCKS_API_KEY?: string;
  FIREBLOCKS_API_SECRET?: string;
  FIREBLOCKS_VAULT_ID?: string;
  FIREBLOCKS_ASSET_ID?: string;
  FIREBLOCKS_API_BASE_URL?: string;

  // Privy configuration (@solana/keychain-privy)
  PRIVY_APP_ID?: string;
  PRIVY_APP_SECRET?: string;
  PRIVY_WALLET_ID?: string;
  PRIVY_API_BASE_URL?: string;
  PRIVY_REQUEST_DELAY_MS?: string;

  // Coinbase CDP Server Wallet configuration (Solana)
  COINBASE_CDP_API_KEY_ID?: string;
  COINBASE_CDP_API_KEY_SECRET?: string;
  COINBASE_CDP_WALLET_SECRET?: string;
  COINBASE_CDP_API_BASE_URL?: string;
  COINBASE_CDP_NETWORK?: "solana" | "solana-devnet";
  COINBASE_CDP_WALLET_ID?: string;
  COINBASE_CDP_ACCOUNT_NAMESPACE?: string;

  // Para Server Wallet configuration (Solana)
  PARA_API_KEY?: string;
  PARA_API_BASE_URL?: string;
  PARA_REQUEST_DELAY_MS?: string;
  PARA_WALLET_ID?: string;

  // Turnkey Server Wallet configuration (Solana)
  TURNKEY_API_PUBLIC_KEY?: string;
  TURNKEY_API_PRIVATE_KEY?: string;
  TURNKEY_ORGANIZATION_ID?: string;
  TURNKEY_API_BASE_URL?: string;
  TURNKEY_REQUEST_DELAY_MS?: string;
  TURNKEY_PRIVATE_KEY_ID?: string;
  TURNKEY_PUBLIC_KEY?: string;

  // DFNS Server Wallet configuration (Solana)
  DFNS_AUTH_TOKEN?: string;
  DFNS_CREDENTIAL_ID?: string;
  DFNS_PRIVATE_KEY?: string;
  DFNS_API_BASE_URL?: string;
  DFNS_WALLET_ID?: string;

  // Anchorage wallet lifecycle configuration
  ANCHORAGE_API_KEY?: string;
  ANCHORAGE_API_BASE_URL?: string;

  // Utila Server Wallet configuration (Solana)
  UTILA_SERVICE_ACCOUNT_EMAIL?: string;
  UTILA_SERVICE_ACCOUNT_PRIVATE_KEY?: string;
  UTILA_VAULT_ID?: string;
  UTILA_WALLET_ID?: string;
  UTILA_NETWORK?: "networks/solana-devnet" | "networks/solana-mainnet";
  UTILA_API_BASE_URL?: string;
  UTILA_POLL_INTERVAL_MS?: string;
  UTILA_MAX_POLL_ATTEMPTS?: string;
  UTILA_DESIGNATED_SIGNERS?: string;

  // Kora (gasless) configuration
  FEE_PAYMENT_PROVIDER?: "kora" | "native";
  KORA_RPC_URL?: string;
  KORA_API_KEY?: string;
  KORA_TIMEOUT_MS?: string;
  KORA_SURFPOOL_SHIM?: string;
  KORA_SURFPOOL_ABL_REMOVE_TIMEOUT_MS?: string;

  // MagicBlock private payments configuration
  MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL?: string;
  MAGICBLOCK_PRIVATE_PAYMENTS_AUTH_TOKEN?: string;

  // Recurring payments backend feature flag
  PAYMENTS_RECURRING_ENABLED?: string;
  PAYMENTS_RECURRING_COLLECTION_ENABLED?: string;
  PAYMENTS_RECURRING_COLLECTION_BATCH_SIZE?: string;
  PAYMENTS_RECURRING_COLLECTION_RETRY_AFTER_MINUTES?: string;

  // Compliance providers
  RANGE_API_KEY?: string;
  RANGE_API_BASE_URL?: string;
  ELLIPTIC_API_TOKEN?: string;
  ELLIPTIC_API_KEY?: string;
  ELLIPTIC_API_SECRET?: string;
  ELLIPTIC_API_BASE_URL?: string;
  TRM_API_KEY?: string;
  TRM_API_BASE_URL?: string;
  CHAINALYSIS_API_KEY?: string;
  CHAINALYSIS_API_BASE_URL?: string;

  // Google address completion (Places API New + Maps Static API)
  GOOGLE_ADDRESS_COMPLETION_API_KEY?: string;

  // MoonPay ramps configuration
  MOONPAY_API_KEY?: string;
  MOONPAY_SECRET_KEY?: string;
  MOONPAY_ONRAMP_URL?: string;
  MOONPAY_OFFRAMP_URL?: string;
  MOONPAY_SANDBOX_API_KEY?: string;
  MOONPAY_SANDBOX_SECRET_KEY?: string;
  MOONPAY_WEBHOOK_KEY?: string;
  MOONPAY_SANDBOX_WEBHOOK_KEY?: string;

  // Lightspark Grid ramps configuration
  LIGHTSPARK_GRID_CLIENT_ID?: string;
  LIGHTSPARK_GRID_CLIENT_SECRET?: string;
  LIGHTSPARK_GRID_API_BASE_URL?: string;
  LIGHTSPARK_GRID_WEBHOOK_PUBLIC_KEY?: string;
  LIGHTSPARK_GRID_SANDBOX_CLIENT_ID?: string;
  LIGHTSPARK_GRID_SANDBOX_CLIENT_SECRET?: string;
  LIGHTSPARK_GRID_SANDBOX_WEBHOOK_PUBLIC_KEY?: string;

  // BVNK ramps configuration
  BVNK_HAWK_AUTH_ID?: string;
  BVNK_HAWK_SECRET_KEY?: string;
  BVNK_WALLET_ID?: string;
  BVNK_WEBHOOK_SECRET?: string;
  BVNK_API_BASE_URL?: string;
  BVNK_SIGNING_HOST?: string;
  PROXY_SHARED_SECRET?: string;
  BVNK_SANDBOX_HAWK_AUTH_ID?: string;
  BVNK_SANDBOX_HAWK_SECRET_KEY?: string;
  BVNK_SANDBOX_WALLET_ID?: string;
  BVNK_SANDBOX_WEBHOOK_SECRET?: string;

  // MoneyGram ramps configuration
  MONEYGRAM_SANDBOX_PUBLIC_KEY?: string;
  MONEYGRAM_SANDBOX_SECRET_KEY?: string;

  // Coinbase Onramp (headless v2) authenticates with the account-wide CDP Secret API Key
  // (COINBASE_CDP_API_KEY_ID/_SECRET above). Only the webhook signing secret is ramps-specific.
  COINBASE_CDP_RAMPS_WEBHOOK_SECRET?: string;
}

// Extend Hono's context with our bindings
declare module "hono" {
  interface ContextVariableMap {
    // API key auth context set by middleware
    projectId?: string;
    apiKey?: {
      id: string;
      organizationId: string;
      projectId: string;
      role: string;
      permissions: Permission[];
      environment: ApiKeyEnvironment;
      signingWalletId: string | null;
      signingWalletIds?: string[];
      walletBindings?: Array<{
        walletId: string;
        permissions: Permission[];
      }>;
    };
    // Session auth context set by middleware
    session?: CachedSession;
    // Clerk auth context set by middleware
    clerk?: {
      userId: string;
      organizationId: string;
      permissions: Permission[];
      role: string;
      clerkUserId: string;
      clerkOrgId: string;
      email: string | null;
      orgSlug: string | null;
      orgRole: string | null;
    };
    clerkOnboarding?: {
      clerkUserId: string;
      clerkOrgId: string;
      orgSlug: string | null;
      orgRole: string | null;
      email: string;
    };
    verifiedClerkJwt?: {
      token: string;
      payload: ClerkJwtPayload;
    };
    requestId: string;
    traceId: string;
    requestSource: string;
    // Runtime-neutral KV bundle, populated by kvStoreMiddleware.
    kv: KVStoreSet;
  }
}

declare global {
  type DatabaseClient = import("@/db").DatabaseClient;
}
