/**
 * Cloudflare Worker Environment Bindings
 *
 * These types define the bindings available in the Worker runtime,
 * configured via wrangler.toml.
 */

import type { HyperdriveBinding } from "@/db";
import type { ClerkJwtPayload } from "@/lib/clerk-token";
import type { KVStoreSet } from "@/runtime/kv";
import type { CachedSession, OrganizationRpcProvider, Permission } from "@sdp/types";

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

  // Environment variables
  ENVIRONMENT: "development" | "production";
  API_VERSION: string;

  // Deployment mode. "managed" (default) uses tier-based provider entitlements
  // synced from Clerk. "self_hosted" treats every configured provider as
  // entitled regardless of org tier, so the platform runs with whatever
  // provider env vars are present. Per-org providerOverrides still apply as
  // a disable-only mechanism.
  SDP_DEPLOYMENT_MODE?: "managed" | "self_hosted";

  // Secrets (set via wrangler secret)
  API_KEY_PEPPER?: string;
  CUSTODY_ENCRYPTION_KEY?: string; // For encrypting org private keys in DB
  SENTRY_DSN?: string;
  SENTRY_TRACES_SAMPLE_RATE?: string;

  // Email configuration
  EMAIL_PROVIDER?: "resend" | "console";
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
    | "anchorage";
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

  // Kora (gasless) configuration
  FEE_PAYMENT_PROVIDER?: "kora" | "native";
  KORA_RPC_URL?: string;
  KORA_API_KEY?: string;
  KORA_TIMEOUT_MS?: string;

  // MoonPay ramps configuration
  MOONPAY_API_KEY?: string;
  MOONPAY_SECRET_KEY?: string;
  MOONPAY_ONRAMP_URL?: string;
  MOONPAY_OFFRAMP_URL?: string;

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
  // Lightspark Grid ramps configuration
  LIGHTSPARK_GRID_CLIENT_ID?: string;
  LIGHTSPARK_GRID_CLIENT_SECRET?: string;
  LIGHTSPARK_GRID_API_BASE_URL?: string;

  // BVNK ramps configuration
  BVNK_API_TOKEN?: string;
  BVNK_HAWK_AUTH_ID?: string;
  BVNK_HAWK_SECRET_KEY?: string;
  BVNK_WALLET_ID?: string;
  BVNK_API_BASE_URL?: string;
}

// Extend Hono's context with our bindings
declare module "hono" {
  interface ContextVariableMap {
    // API key auth context set by middleware
    apiKey?: {
      id: string;
      organizationId: string;
      projectId?: string | null;
      role: string;
      permissions: Permission[];
      environment: string;
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
