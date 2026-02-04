/**
 * Cloudflare Worker Environment Bindings
 *
 * These types define the bindings available in the Worker runtime,
 * configured via wrangler.toml.
 */

import type { CachedSession, Permission } from "@sdp/types";

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

  // Allowlist configuration
  ALLOWLIST_PROVIDER?: "d1" | "clerk";
  ALLOWLIST_ADMIN_KEY?: string;
  ALLOWLIST_ADMIN_ORG_ID?: string;
  ALLOWLIST_ADMIN_ORG_SLUG?: string;

  // Solana configuration
  SOLANA_RPC_URL?: string;
  SOLANA_NETWORK?: "devnet" | "mainnet-beta";
  CUSTODY_PRIVATE_KEY?: string;
  SOLANA_MOCK?: string;
  RUN_INTEGRATION_TESTS?: string;

  // Signing provider (custody backend via @solana/keychain)
  SIGNING_PROVIDER?: "local" | "fireblocks";
  FEE_PAYER_PRIVATE_KEY?: string;

  // Fireblocks configuration (@solana/keychain-fireblocks)
  FIREBLOCKS_API_KEY?: string;
  FIREBLOCKS_API_SECRET?: string;
  FIREBLOCKS_VAULT_ID?: string;
  FIREBLOCKS_ASSET_ID?: string;
  FIREBLOCKS_API_BASE_URL?: string;

  // Kora (gasless) configuration
  FEE_PAYMENT_PROVIDER?: "kora" | "native";
  KORA_RPC_URL?: string;
  KORA_API_KEY?: string;
  KORA_TIMEOUT_MS?: string;
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
    requestId: string;
  }
}
