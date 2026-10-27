/** Environment variables consumed by the Node API runtime. */

import type { WalletAccess } from "@/lib/auth";
import type { ClerkJwtPayload } from "@/lib/clerk-token";
import type { GatewayIdentity } from "@/lib/gateway-identity";
import type { Action } from "@sdp/types/actions";
import type { ApiKeyEnvironment } from "@sdp/types/api-keys";
import type { EgressReadiness } from "@sdp/types/health";
import type { OrganizationEntitlements } from "@sdp/types/organization-entitlements";
import type { OrganizationRpcProvider } from "@sdp/types/organizations";
import type { OrganizationRole } from "@sdp/types/roles";
import type { SdpRampProviderMaturity } from "@sdp/types/release-channels";
import type { ManagedRpcEnv } from "@sdp/rpc/types";
import type { RequestGateContext } from "@/middleware/request-gate";
import type { KVStoreSet } from "@/runtime/kv";

export interface Env extends ManagedRpcEnv {
  // Runtime data services
  DATABASE_URL?: string;
  // "off" sends every database statement unnamed, so PostgreSQL plans each one
  // again. Needed behind a transaction-mode connection pooler; parsed at startup
  // by src/db/database-env.ts.
  DATABASE_PREPARED_STATEMENTS?: string;
  REDIS_URL?: string;

  // Cloud Run services disable embedded cron by default so only the Worker
  // service (which sets "false") schedules Cron Definitions. Other Node
  // runtimes remain enabled by default and may opt out with "true"/"1".
  DISABLE_CRON?: string;

  // Environment variables
  ENVIRONMENT: "development" | "production";
  API_VERSION: string;
  /** Build SHA baked into the image; shared by the api and worker services. */
  SDP_BUILD_SHA?: string;
  // Injected automatically by Cloud Run services and jobs.
  K_SERVICE?: string;
  K_REVISION?: string;
  CLOUD_RUN_JOB?: string;
  // Explicit proxy-trust assertion; never inferred from K_SERVICE (APE-810).
  // "gclb": ingress is restricted to the Google external load balancer, which
  // appends the verified client address. "true": a deployment-owned proxy
  // replaces caller-supplied forwarding headers. Unset: forwarded headers are
  // caller-controlled and no client IP resolves.
  TRUST_PROXY_HEADERS?: string;
  // The Foundation API gateway's identity issuer and JWKS (HOO-2256). Set
  // together, or neither: unset, `X-SF-Identity` is ignored.
  SF_GATEWAY_ISSUER?: string;
  SF_GATEWAY_JWKS_URL?: string;

  // Public-facing origin of this API (e.g. "https://api.example.com"). The
  // SDP-hosted token metadata URL burned into the on-chain MetadataPointer is
  // built from this value and nothing else — it is never derived from the
  // incoming request, so a spoofed Host header can't pin a hostile origin into
  // a mint. Deploys that need the SDP-hosted metadata fallback fail closed when
  // it is unset or not a valid http(s) origin.
  PUBLIC_API_ORIGIN?: string;

  // Deployment mode. "managed" (default) uses tier-based provider entitlements
  // synced from Clerk. "self_hosted" treats every configured provider as
  // entitled regardless of org tier, so the platform runs with whatever
  // provider env vars are present. Per-org providerOverrides still apply as
  // a disable-only mechanism.
  SDP_DEPLOYMENT_MODE?: "managed" | "self_hosted";

  // Release channel: which modules this deployment can run at all (`@sdp/types`
  // release channels). Required: a missing or unknown name fails at boot.
  SDP_RELEASE_CHANNEL?: string;

  // Credential secret store selection for BYO custody credentials.
  // Managed SDP should use GCP Secret Manager. Self-hosted deployments default
  // to encrypted DB storage.
  CREDENTIAL_SECRET_STORE_BACKEND?: "gcp_secret_manager" | "encrypted_db";
  GCP_SECRET_MANAGER_PROJECT_ID?: string;
  GCP_SECRET_MANAGER_SECRET_PREFIX?: string;
  GCP_SECRET_MANAGER_API_BASE_URL?: string;

  // Application secrets
  API_KEY_PEPPER?: string;
  CREDENTIAL_FINGERPRINT_PEPPER?: string;
  CUSTODY_ENCRYPTION_KEY?: string; // For encrypting org private keys in DB
  CUSTODY_KMS_KEY_NAME?: string;
  CUSTODY_KMS_API_BASE_URL?: string;
  CUSTODY_KMS_METADATA_TOKEN_URL?: string;
  SPC_CREDENTIAL_ENCRYPTION_KEY?: string; // For encrypting invited SPC user passwords
  SPC_CREDENTIAL_KMS_KEY_NAME?: string; // Optional Cloud KMS key for SPC credential envelopes
  FRONTEND_URL?: string;

  // Clerk configuration
  CLERK_ISSUER?: string;
  CLERK_JWKS_URL?: string;
  CLERK_SECRET_KEY?: string;
  CLERK_API_URL?: string;
  CLERK_WEBHOOK_SECRET?: string;

  // Allowlist configuration
  ALLOWLIST_ADMIN_KEY?: string;
  ALLOWLIST_ADMIN_ORG_ID?: string;

  // Solana configuration
  SOLANA_RPC_URL?: string;
  /**
   * Optional per-cluster pins, read only by the deprecated `createClusterRpc(env, cluster)` in
   * `@sdp/rpc/solana` (Private Channels, HOO-1879) and the local Kora harness. Earn reads each
   * cluster's managed pool (`SOLANA_RPC_<PROVIDER>_<CLUSTER>_API_KEY_URL`) instead, through
   * `services/earn/cluster-rpc.ts`, and never falls back to `SOLANA_RPC_URL`.
   */
  SOLANA_DEVNET_RPC_URL?: string;
  SOLANA_MAINNET_RPC_URL?: string;
  SOLANA_RPC_DEFAULT_PROVIDER?: OrganizationRpcProvider;
  SOLANA_RPC_TRITON_URL?: string;
  SOLANA_RPC_TRITON_API_KEY?: string;
  SOLANA_RPC_HELIUS_URL?: string;
  SOLANA_RPC_HELIUS_API_KEY?: string;
  /** Tokens.xyz server key with assets:read; used only for display estimates. */
  TOKENS_XYZ_API_KEY?: string;
  /**
   * Jupiter Swap API (swap-funded Earn deposits and provider DEX exits). Fail-closed: with no key
   * present, a deposit that names a `sourceTokenMint` is refused before any
   * network request — the same posture as an absent provider credential.
   * The URL defaults to the keyed production base; override it only to pin a
   * different deployment (e.g. a mock in tests).
   */
  JUPITER_SWAP_API_URL?: string;
  JUPITER_SWAP_API_KEY?: string;
  SOLANA_RPC_ALCHEMY_URL?: string;
  SOLANA_RPC_ALCHEMY_API_KEY?: string;
  SOLANA_RPC_QUICKNODE_URL?: string;
  SOLANA_RPC_QUICKNODE_API_KEY?: string;
  SOLANA_RPC_VALIDATIONCLOUD_URL?: string;
  SOLANA_RPC_VALIDATIONCLOUD_API_KEY?: string;
  SOLANA_RPC_NODIT_URL?: string;
  SOLANA_RPC_NODIT_API_KEY?: string;
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
  | "ibm_haven"
  | "anchorage"
  | "utila";

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

  // IBM Digital Asset Haven configuration (white-label Dfns; Solana)
  IBM_HAVEN_AUTH_TOKEN?: string;
  IBM_HAVEN_CREDENTIAL_ID?: string;
  IBM_HAVEN_PRIVATE_KEY?: string;
  IBM_HAVEN_API_BASE_URL?: string;
  IBM_HAVEN_WALLET_ID?: string;

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
  KORA_TIMEOUT_MS?: string;
  /** One Kora per cluster (see @sdp/fee-payment `resolveKoraEndpoint`). */
  KORA_DEVNET_URL?: string;
  KORA_DEVNET_API_KEY?: string;
  KORA_DEVNET_CLOUD_RUN_AUDIENCE?: string;
  KORA_MAINNET_URL?: string;
  KORA_MAINNET_API_KEY?: string;
  KORA_MAINNET_CLOUD_RUN_AUDIENCE?: string;
  /** The Solana RPC the devnet Kora reads and sends on; sponsorship prices and settles devnet against it. */
  KORA_DEVNET_RPC_URL?: string;
  /** The Solana RPC the mainnet Kora reads and sends on; sponsorship prices and settles mainnet against it. */
  KORA_MAINNET_RPC_URL?: string;
  KORA_PER_TRANSACTION_BUDGET_LAMPORTS?: string;
  KORA_SURFPOOL_SHIM?: string;
  KORA_SURFPOOL_ABL_REMOVE_TIMEOUT_MS?: string;

  // MagicBlock private payments configuration
  MAGICBLOCK_PRIVATE_PAYMENTS_API_BASE_URL?: string;
  MAGICBLOCK_PRIVATE_PAYMENTS_AUTH_TOKEN?: string;

  // Self-hosted Asset Profiles production opt-in; managed rollout uses Vercel.
  SDP_FLAG_ASSET_PROFILES?: string;

  // Private Channels (SPC) feature gate — API routes + deposit/withdrawal cron.
  PRIVATE_CHANNELS_ENABLED?: string;

  // Comma-separated origins (`scheme://host[:port]`) a Private Channels gateway
  // or auth URL may point at. Projects supply those URLs, so this is the list
  // that decides where a probe is allowed to go; the public sandbox is approved
  // without configuring anything. See services/private-channels/egress.ts.
  PRIVATE_CHANNEL_EGRESS_ALLOWLIST?: string;

  // Helius Rings feature gate — devnet-only shielded wallet API routes.
  HELIUS_RINGS_ENABLED?: string;

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

  // data.solana.com, the API behind solana.com/data (the Overview's Solana network figures)
  DATA_API_KEY?: string;

  // Managed ramp provider keys, <PROVIDER>_<MODE>_<ROLE> (services/ramps/runtime.ts).
  // Live (PRODUCTION) keys exist only in prd; a mode without its keys fails closed.
  MOONPAY_SANDBOX_API_KEY?: string;
  MOONPAY_SANDBOX_SECRET_KEY?: string;
  MOONPAY_SANDBOX_WEBHOOK_SECRET?: string;
  MOONPAY_PRODUCTION_API_KEY?: string;
  MOONPAY_PRODUCTION_SECRET_KEY?: string;
  MOONPAY_PRODUCTION_WEBHOOK_SECRET?: string;
  STRIPE_SANDBOX_PUBLISHABLE_KEY?: string;
  STRIPE_SANDBOX_SECRET_KEY?: string;
  STRIPE_SANDBOX_WEBHOOK_SECRET?: string;
  STRIPE_PRODUCTION_PUBLISHABLE_KEY?: string;
  STRIPE_PRODUCTION_SECRET_KEY?: string;
  STRIPE_PRODUCTION_WEBHOOK_SECRET?: string;

  // Markets module gate. Clearing it dark-launches every Markets API surface.
  MARKETS_ENABLED?: string;
  EARN_ENABLED?: string;
  // Optional Hastra PRIME -> wYLDS -> Jupiter -> USDC exit. Off by default;
  // Hastra's operator-settled par redemption remains available independently.
  EARN_HASTRA_DEX_EXIT_ENABLED?: string;
  // Settlement authority for DvP trades. Only this key can Settle or Cancel;
  // the parties can only unwind. It cannot be either party or an executable
  // account. Where it ultimately lives is still an open decision (PRO-1796).
  DVP_SETTLEMENT_AUTHORITY?: string;
  // Whether Kora pays fees AND share-ATA rent for Earn vault movements.
  // Narrowed to devnet by `isEarnVaultSponsorshipEnabled`, never global: one
  // process serves both clusters and withdrawals are not environment-gated.
  EARN_VAULT_FEE_SPONSORSHIP_ENABLED?: string;
  // Whether the Earn volume caps (ADR 0004) refuse deposits. Unset or false is
  // shadow mode: evaluate and emit `sdp_api_earn_volume_cap_evaluated`, refuse
  // nothing. See `isEarnVolumeCapsEnforced`.
  EARN_VOLUME_CAPS_ENFORCED?: string;

  // Earn vault-infra provider configuration
  UPSHIFT_API_KEY?: string;
  UPSHIFT_SANDBOX_API_KEY?: string;
  PERENA_API_KEY?: string;
  PERENA_SANDBOX_API_KEY?: string;
  // Packed JSON: {"clientId","clientSecret","username","password"} — the
  // OAuth2 password-grant quad WisdomTree Connect provisions. One value per
  // environment; format documented on EarnRuntimeEnvironment in @sdp/earn.
  WISDOMTREE_API_KEY?: string;
  WISDOMTREE_SANDBOX_API_KEY?: string;
}

// Extend Hono's context with our bindings
declare module "hono" {
  interface ContextVariableMap {
    // Set by createApp on every request; see AppDeps.rampProviderMaturity
    rampProviderMaturity: SdpRampProviderMaturity;
    // Set by createApp on every request; see AppDeps.egressReadiness
    egressReadiness?: () => EgressReadiness;
    // Set by gatewayIdentityMiddleware from a verified X-SF-Identity
    gatewayIdentity?: GatewayIdentity;
    // API key auth context set by middleware
    projectId?: string;
    projectEnvironment?: ApiKeyEnvironment;
    // Loaded once by authentication for every actor; see lib/production-entitlement.ts
    organizationEntitlements: OrganizationEntitlements;
    // Set by requestGate middleware for gated routes
    requestGate?: RequestGateContext;
    // Set by authorize(): what the route's access check loaded (middleware/authorize.ts)
    authorized?: { loaded: unknown };
    // Set by idempotent() when this request holds its key: the request's fingerprint
    idempotencyFingerprint?: string;
    // Set by idempotent(): the fingerprint under the route's previous canonical form
    idempotencyPreviousFingerprint?: string;
    // Set by idempotent() with the fingerprint: the key this request claimed
    idempotencyClaimedKey?: string;
    // Set by markIdempotencyCommitted() once the handler wrote its domain row
    idempotencyCommitted?: boolean;
    // Set by replayFromRecord when the key's domain row records another request
    idempotencyRecordMismatch?: boolean;
    apiKey?: {
      id: string;
      organizationId: string;
      projectId: string;
      /** The key's explicit grants, read fresh on this request. */
      grants: readonly Action[];
      environment: ApiKeyEnvironment;
      /** The key's wallet scope, read fresh on this request (HOO-2099). */
      walletAccess: WalletAccess;
    };
    // Clerk auth context set by middleware
    clerk?: {
      userId: string;
      organizationId: string;
      /** The member's organization role; its actions are ORGANIZATION_ROLE_ACTIONS[role]. */
      role: OrganizationRole;
      clerkUserId: string;
      clerkOrgId: string;
      email: string | null;
      orgSlug: string | null;
    };
    // Set by clerkSignupSessionMiddleware: a verified person with no organization
    clerkSignup?: {
      userId: string;
      clerkUserId: string;
      email: string;
    };
    clerkOnboarding?: {
      clerkUserId: string;
      clerkOrgId: string;
      orgSlug: string | null;
      email: string;
      organizationId: string | null;
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
  type DatabaseClient = import("@/db/client").DatabaseClient;
}
