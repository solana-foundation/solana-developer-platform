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

  // Email configuration
  EMAIL_PROVIDER?: "resend" | "console";
  EMAIL_FROM?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  FRONTEND_URL?: string;

  // Solana configuration
  SOLANA_RPC_URL?: string;
  SOLANA_NETWORK?: "devnet" | "mainnet-beta";
  CUSTODY_PRIVATE_KEY?: string;
  SOLANA_MOCK?: string;
  RUN_INTEGRATION_TESTS?: string;

  // Signing provider configuration
  SIGNING_PROVIDER?: "local" | "fireblocks";
  FEE_PAYER_PRIVATE_KEY?: string;

  // Fireblocks configuration
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
    requestId: string;
  }
}
