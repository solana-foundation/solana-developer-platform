/**
 * Cloudflare Worker Environment Bindings
 *
 * These types define the bindings available in the Worker runtime,
 * configured via wrangler.toml.
 */

import type { CachedSession, OrganizationRpcProvider, Permission } from "@sdp/types";

export interface Env {
  // D1 Database
  DB: D1Database;

  // KV Namespaces
  SDP_API_KEYS: KVNamespace;
  SDP_RATE_LIMITS: KVNamespace;
  SDP_CACHE: KVNamespace;
  SDP_SESSIONS: KVNamespace;

  // Environment variables
  ENVIRONMENT: "development" | "staging" | "production";
  API_VERSION: string;

  // Secrets (set via wrangler secret)
  API_KEY_PEPPER?: string;
  CUSTODY_ENCRYPTION_KEY?: string; // For encrypting org private keys in DB

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
  ALLOWLIST_ADMIN_ORG_SLUG?: string;

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
  ORGANIZATION_REGISTRATION_TOKEN?: string;

  // Signing provider (custody backend via @solana/keychain)
  SIGNING_PROVIDER?: "local" | "fireblocks" | "privy" | "coinbase_cdp" | "para" | "turnkey";
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
    requestId: string;
  }
}
