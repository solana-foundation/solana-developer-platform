/**
 * Cloudflare Worker Environment Bindings
 *
 * These types define the bindings available in the Worker runtime,
 * configured via wrangler.toml.
 */

export interface Env {
  // D1 Database
  DB: D1Database;

  // KV Namespaces
  SDP_API_KEYS: KVNamespace;
  SDP_RATE_LIMITS: KVNamespace;
  SDP_CACHE: KVNamespace;

  // Environment variables
  ENVIRONMENT: "development" | "staging" | "production";
  API_VERSION: string;

  // Secrets (set via wrangler secret)
  API_KEY_PEPPER?: string;
}

// Extend Hono's context with our bindings
declare module "hono" {
  interface ContextVariableMap {
    // Auth context set by middleware
    apiKey?: {
      id: string;
      organizationId: string;
      role: string;
      permissions: string[];
      environment: string;
    };
    requestId: string;
  }
}
