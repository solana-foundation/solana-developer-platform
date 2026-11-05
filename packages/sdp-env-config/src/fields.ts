import type { EnvField, SectionMeta, SelectOption, Values } from "./types";

export const SECTIONS: SectionMeta[] = [
  { id: "basic", title: "Basic", comment: "Core runtime" },
  { id: "database", title: "Database", comment: "Database (bundled Postgres or external)" },
  { id: "cache", title: "Cache", comment: "Cache (bundled Redis or external)" },
  { id: "rpc", title: "Solana RPC", comment: "Solana RPC" },
  { id: "clerk", title: "Authentication (Clerk)", comment: "Authentication (Clerk) — required" },
  { id: "signing", title: "Signing provider", comment: "Signing provider" },
  { id: "fee", title: "Fee payment", comment: "Fee payment" },
  {
    id: "secrets",
    title: "Secrets",
    comment: "App secrets — generated locally",
  },
  {
    id: "advanced",
    title: "Advanced",
    comment: "Image source, ports, internal URLs",
    advanced: true,
  },
];

const isProvider = (key: string, value: string) => (v: Values) => v[key] === value;

/** Split a comma-separated list value (e.g. SIGNING_PROVIDERS) into trimmed entries. */
export const parseList = (value: string | undefined): string[] =>
  value
    ? value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

/** Predicate: the comma-separated list at `key` includes `value`. */
const listIncludes = (key: string, value: string) => (v: Values) =>
  parseList(v[key]).includes(value);

const KORA_RPC_URL_HELP =
  "The Solana RPC endpoint this Kora reads. SDP prices and settles sponsored fees through it, and won't start with only one of the two Kora URLs set.";
const KORA_API_KEY_HELP = "Optional. The API key your Kora requires, if it requires one.";
const KORA_CLOUD_RUN_AUDIENCE_HELP =
  "Optional. Fetches a Google service identity token for a private Kora Cloud Run service while retaining Kora API-key authentication.";

/** Curated provider set the configurator collects full env for. */
const SIGNING_PROVIDER_OPTIONS: SelectOption[] = [
  { value: "local", label: "local" },
  { value: "fireblocks", label: "Fireblocks" },
  { value: "privy", label: "Privy" },
  { value: "coinbase_cdp", label: "Coinbase CDP" },
  { value: "para", label: "Para" },
  { value: "turnkey", label: "Turnkey" },
  { value: "utila", label: "Utila" },
];

export const FIELDS: EnvField[] = [
  // Basic
  {
    key: "ENVIRONMENT",
    section: "basic",
    kind: "select",
    label: "Environment",
    defaultValue: "production",
    options: [
      { value: "production", label: "production" },
      { value: "development", label: "development" },
    ],
    help: "App runtime mode: production hardens logging and error handling; development is for local testing.",
  },
  {
    // Always self-hosted for this configurator; emitted as a constant, not shown.
    key: "SDP_DEPLOYMENT_MODE",
    section: "basic",
    kind: "text",
    label: "Deployment mode",
    derive: () => "self_hosted",
  },

  // Database
  {
    key: "DATABASE_MODE",
    section: "database",
    kind: "select",
    label: "Database",
    defaultValue: "bundled",
    options: [
      { value: "bundled", label: "Bundled Postgres" },
      { value: "external", label: "External" },
    ],
  },
  {
    key: "POSTGRES_DB",
    section: "database",
    kind: "text",
    label: "Postgres database",
    defaultValue: "sdp",
    visibleWhen: isProvider("DATABASE_MODE", "bundled"),
  },
  {
    key: "POSTGRES_USER",
    section: "database",
    kind: "text",
    label: "Postgres user",
    defaultValue: "sdp",
    visibleWhen: isProvider("DATABASE_MODE", "bundled"),
  },
  {
    key: "POSTGRES_PASSWORD_MODE",
    section: "database",
    kind: "select",
    label: "Postgres password",
    defaultValue: "auto",
    visibleWhen: isProvider("DATABASE_MODE", "bundled"),
    options: [
      { value: "auto", label: "Auto-generate" },
      { value: "manual", label: "Set manually" },
    ],
    help: "Auto-generate a strong password, or set your own.",
  },
  {
    key: "POSTGRES_PASSWORD",
    section: "database",
    kind: "password",
    label: "Password",
    required: true,
    visibleWhen: isProvider("DATABASE_MODE", "bundled"),
    // Auto-generate unless the operator chose manual entry for the bundled DB.
    // With an external database the field is hidden and manual mode unreachable,
    // so always auto-generate — compose still needs a value and the form offers
    // no way to type one.
    secretWhen: (v) => v.DATABASE_MODE !== "bundled" || v.POSTGRES_PASSWORD_MODE !== "manual",
    // The bundled Postgres container always starts and requires this, even with
    // an external database, so emit an auto-generated value while hiding the field.
    alwaysEmit: true,
  },
  {
    key: "DATABASE_URL",
    section: "database",
    kind: "url",
    label: "External database URL",
    required: true,
    help: "External Postgres connection string, e.g. postgresql://…@host:5432/dbname",
    pattern: /^postgres(ql)?:\/\//,
    visibleWhen: isProvider("DATABASE_MODE", "external"),
  },

  // Cache
  {
    key: "CACHE_MODE",
    section: "cache",
    kind: "select",
    label: "Cache",
    defaultValue: "bundled",
    options: [
      { value: "bundled", label: "Bundled Redis" },
      { value: "external", label: "External" },
    ],
  },
  {
    key: "REDIS_URL",
    section: "cache",
    kind: "url",
    label: "Redis URL",
    defaultValue: "redis://redis:6379",
    pattern: /^redis(s)?:\/\//,
  },

  // Solana RPC
  {
    key: "SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL",
    section: "rpc",
    kind: "url",
    label: "Devnet RPC URL",
    defaultValue: "https://api.devnet.solana.com",
    required: true,
    pattern: /^https:\/\//,
    help: "Sandbox projects read and send on devnet through this endpoint.",
  },
  {
    key: "SOLANA_RPC_DEFAULT_MAINNET_API_KEY_URL",
    section: "rpc",
    kind: "url",
    label: "Mainnet RPC URL",
    pattern: /^https:\/\//,
    help: "Production projects read and send on mainnet through this endpoint; unset refuses them.",
  },

  // Clerk
  {
    key: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    section: "clerk",
    kind: "text",
    label: "Publishable key",
    required: true,
    pattern: /^pk_/,
    help: "Clerk Dashboard → API Keys",
  },
  {
    key: "CLERK_SECRET_KEY",
    section: "clerk",
    kind: "password",
    label: "Secret key",
    required: true,
    pattern: /^sk_/,
    help: "Clerk Dashboard → API Keys",
  },
  {
    key: "CLERK_ISSUER",
    section: "clerk",
    kind: "url",
    label: "Issuer",
    required: true,
    pattern: /^https:\/\//,
    help: "https://<slug>.clerk.accounts.dev for dev instances",
  },
  {
    key: "FRONTEND_URL",
    section: "clerk",
    kind: "url",
    label: "Dashboard URL",
    required: true,
    pattern: /^https?:\/\//,
    defaultValue: "http://localhost:3000",
    help: "The URL the browser loads the dashboard from; in production the API accepts only Clerk sessions issued to this origin",
  },
  {
    key: "CLERK_WEBHOOK_SECRET",
    section: "clerk",
    kind: "password",
    label: "Webhook signing secret",
    pattern: /^whsec_/,
    help: "Required for org auto-provisioning.",
  },

  // Signing
  {
    key: "SIGNING_PROVIDERS",
    section: "signing",
    kind: "multiselect",
    label: "Deployment signing providers",
    defaultValue: "local",
    required: true,
    options: SIGNING_PROVIDER_OPTIONS,
    help: "Providers this deployment holds credentials for. Not written to the file: it only picks which credential fields appear. Dashboard-stored Connections are configured separately.",
  },
  {
    key: "SIGNING_PROVIDER",
    section: "signing",
    kind: "select",
    label: "Startup signing provider",
    defaultValue: "local",
    required: true,
    optionsWhen: (v) =>
      parseList(v.SIGNING_PROVIDERS).map(
        (p) => SIGNING_PROVIDER_OPTIONS.find((o) => o.value === p) ?? { value: p, label: p }
      ),
    help: "Read only at startup, where local needs SDP_DEPLOYMENT_MODE=self_hosted, which this file always sets. Each project picks its own signer when you set up custody in the dashboard.",
  },
  {
    key: "CUSTODY_PRIVATE_KEY",
    section: "signing",
    kind: "password",
    label: "Local signer key (base58)",
    required: true,
    visibleWhen: listIncludes("SIGNING_PROVIDERS", "local"),
    help: "SDP offers the local signer only while this is set, and never signs with it: each project's local signer generates its own keypair.",
  },
  {
    key: "FIREBLOCKS_API_KEY",
    section: "signing",
    kind: "password",
    label: "Fireblocks API key",
    required: true,
    visibleWhen: listIncludes("SIGNING_PROVIDERS", "fireblocks"),
  },
  {
    key: "FIREBLOCKS_API_SECRET",
    section: "signing",
    kind: "password",
    label: "Fireblocks API secret",
    required: true,
    visibleWhen: listIncludes("SIGNING_PROVIDERS", "fireblocks"),
  },
  {
    key: "PRIVY_APP_ID",
    section: "signing",
    kind: "text",
    label: "Privy deployment app ID",
    required: true,
    visibleWhen: listIncludes("SIGNING_PROVIDERS", "privy"),
  },
  {
    key: "PRIVY_APP_SECRET",
    section: "signing",
    kind: "password",
    label: "Privy deployment app secret",
    required: true,
    visibleWhen: listIncludes("SIGNING_PROVIDERS", "privy"),
  },
  {
    key: "COINBASE_CDP_API_KEY_ID",
    section: "signing",
    kind: "text",
    label: "Coinbase CDP API key ID",
    required: true,
    visibleWhen: listIncludes("SIGNING_PROVIDERS", "coinbase_cdp"),
  },
  {
    key: "COINBASE_CDP_API_KEY_SECRET",
    section: "signing",
    kind: "password",
    label: "Coinbase CDP API key secret",
    required: true,
    visibleWhen: listIncludes("SIGNING_PROVIDERS", "coinbase_cdp"),
  },
  {
    key: "COINBASE_CDP_WALLET_SECRET",
    section: "signing",
    kind: "password",
    label: "Coinbase CDP wallet secret",
    required: true,
    visibleWhen: listIncludes("SIGNING_PROVIDERS", "coinbase_cdp"),
  },
  {
    key: "PARA_API_KEY",
    section: "signing",
    kind: "password",
    label: "Para API key",
    required: true,
    visibleWhen: listIncludes("SIGNING_PROVIDERS", "para"),
  },
  {
    key: "TURNKEY_API_PUBLIC_KEY",
    section: "signing",
    kind: "text",
    label: "Turnkey API public key",
    required: true,
    visibleWhen: listIncludes("SIGNING_PROVIDERS", "turnkey"),
  },
  {
    key: "TURNKEY_API_PRIVATE_KEY",
    section: "signing",
    kind: "password",
    label: "Turnkey API private key",
    required: true,
    visibleWhen: listIncludes("SIGNING_PROVIDERS", "turnkey"),
  },
  {
    key: "TURNKEY_ORGANIZATION_ID",
    section: "signing",
    kind: "text",
    label: "Turnkey organization ID",
    required: true,
    visibleWhen: listIncludes("SIGNING_PROVIDERS", "turnkey"),
  },
  {
    key: "UTILA_SERVICE_ACCOUNT_EMAIL",
    section: "signing",
    kind: "text",
    label: "Utila service account email",
    required: true,
    visibleWhen: listIncludes("SIGNING_PROVIDERS", "utila"),
    pattern: /^[^@\s]+@vault\.[^@\s]+\.utilaserviceaccount\.io$/,
  },
  {
    key: "UTILA_SERVICE_ACCOUNT_PRIVATE_KEY",
    section: "signing",
    kind: "password",
    label: "Utila service account private key",
    required: true,
    visibleWhen: listIncludes("SIGNING_PROVIDERS", "utila"),
    help: "PKCS#8 private key PEM for the Utila service account. Use escaped newlines when storing in .env.",
  },
  {
    key: "UTILA_VAULT_ID",
    section: "signing",
    kind: "text",
    label: "Utila vault ID",
    required: true,
    visibleWhen: listIncludes("SIGNING_PROVIDERS", "utila"),
  },
  {
    key: "UTILA_NETWORK",
    section: "signing",
    kind: "select",
    label: "Utila network",
    defaultValue: "networks/solana-devnet",
    required: true,
    visibleWhen: listIncludes("SIGNING_PROVIDERS", "utila"),
    options: [
      { value: "networks/solana-devnet", label: "Solana devnet" },
      { value: "networks/solana-mainnet", label: "Solana mainnet" },
    ],
  },
  {
    key: "UTILA_API_BASE_URL",
    section: "signing",
    kind: "url",
    label: "Utila API base URL",
    defaultValue: "https://api.utila.io",
    visibleWhen: listIncludes("SIGNING_PROVIDERS", "utila"),
    pattern: /^https:\/\//,
  },
  {
    key: "UTILA_POLL_INTERVAL_MS",
    section: "signing",
    kind: "text",
    label: "Utila poll interval (ms)",
    defaultValue: "1000",
    visibleWhen: listIncludes("SIGNING_PROVIDERS", "utila"),
    pattern: /^[1-9]\d*$/,
  },
  {
    key: "UTILA_MAX_POLL_ATTEMPTS",
    section: "signing",
    kind: "text",
    label: "Utila max poll attempts",
    defaultValue: "60",
    visibleWhen: listIncludes("SIGNING_PROVIDERS", "utila"),
    pattern: /^[1-9]\d*$/,
  },
  {
    key: "UTILA_DESIGNATED_SIGNERS",
    section: "signing",
    kind: "text",
    label: "Utila designated signers",
    visibleWhen: listIncludes("SIGNING_PROVIDERS", "utila"),
    help: "Comma-separated Utila user resources. Leave empty to default to users/$UTILA_SERVICE_ACCOUNT_EMAIL.",
  },

  // Fee. The API reads only the KORA_<CLUSTER>_* keys: a cluster with a Kora sponsors fees through
  // it, and the API refuses to start when a cluster names its Kora URL without its RPC URL, or
  // the reverse, so each chosen cluster requires both.
  {
    key: "FEE_SPONSOR_CLUSTERS",
    section: "fee",
    kind: "multiselect",
    label: "Sponsor fees with Kora on",
    options: [
      { value: "devnet", label: "Devnet (Sandbox projects)" },
      { value: "mainnet", label: "Mainnet (Production projects)" },
    ],
    help: "SDP pays transaction fees through a Kora on each project's cluster. Without one, sends that SDP sponsors, such as payment transfers, answer 503 PROVIDER_UNAVAILABLE.",
  },
  {
    key: "KORA_DEVNET_URL",
    section: "fee",
    kind: "url",
    label: "Devnet Kora URL",
    required: true,
    pattern: /^https?:\/\//,
    visibleWhen: listIncludes("FEE_SPONSOR_CLUSTERS", "devnet"),
    help: "The Kora that pays fees for Sandbox projects.",
  },
  {
    key: "KORA_DEVNET_RPC_URL",
    section: "fee",
    kind: "url",
    label: "Devnet Kora RPC URL",
    required: true,
    pattern: /^https?:\/\//,
    visibleWhen: listIncludes("FEE_SPONSOR_CLUSTERS", "devnet"),
    help: KORA_RPC_URL_HELP,
  },
  {
    key: "KORA_DEVNET_API_KEY",
    section: "fee",
    kind: "password",
    label: "Devnet Kora API key",
    visibleWhen: listIncludes("FEE_SPONSOR_CLUSTERS", "devnet"),
    help: KORA_API_KEY_HELP,
  },
  {
    key: "KORA_DEVNET_CLOUD_RUN_AUDIENCE",
    section: "fee",
    kind: "url",
    label: "Devnet private Kora Cloud Run audience",
    pattern: /^https?:\/\//,
    visibleWhen: listIncludes("FEE_SPONSOR_CLUSTERS", "devnet"),
    help: KORA_CLOUD_RUN_AUDIENCE_HELP,
  },
  {
    key: "KORA_MAINNET_URL",
    section: "fee",
    kind: "url",
    label: "Mainnet Kora URL",
    required: true,
    pattern: /^https?:\/\//,
    visibleWhen: listIncludes("FEE_SPONSOR_CLUSTERS", "mainnet"),
    help: "The Kora that pays fees for Production projects.",
  },
  {
    key: "KORA_MAINNET_RPC_URL",
    section: "fee",
    kind: "url",
    label: "Mainnet Kora RPC URL",
    required: true,
    pattern: /^https?:\/\//,
    visibleWhen: listIncludes("FEE_SPONSOR_CLUSTERS", "mainnet"),
    help: KORA_RPC_URL_HELP,
  },
  {
    key: "KORA_MAINNET_API_KEY",
    section: "fee",
    kind: "password",
    label: "Mainnet Kora API key",
    visibleWhen: listIncludes("FEE_SPONSOR_CLUSTERS", "mainnet"),
    help: KORA_API_KEY_HELP,
  },
  {
    key: "KORA_MAINNET_CLOUD_RUN_AUDIENCE",
    section: "fee",
    kind: "url",
    label: "Mainnet private Kora Cloud Run audience",
    pattern: /^https?:\/\//,
    visibleWhen: listIncludes("FEE_SPONSOR_CLUSTERS", "mainnet"),
    help: KORA_CLOUD_RUN_AUDIENCE_HELP,
  },

  // Secrets (auto-generated locally)
  {
    key: "API_KEY_PEPPER",
    section: "secrets",
    kind: "secret",
    label: "API key pepper",
    required: true,
  },
  {
    key: "CREDENTIAL_FINGERPRINT_PEPPER",
    section: "secrets",
    kind: "secret",
    label: "Credential fingerprint pepper",
    required: true,
    help: "HMAC key for stored/runtime Credential submission fingerprints. Keep it stable so committed requests remain replayable.",
  },
  {
    key: "CUSTODY_ENCRYPTION_KEY",
    section: "secrets",
    kind: "secret",
    secretEncoding: "base64",
    label: "Custody encryption key",
    required: true,
  },
  {
    key: "CUSTODY_KMS_KEY_NAME",
    section: "secrets",
    kind: "text",
    label: "Cloud KMS key name",
    pattern: /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/,
    help: "Optional Cloud KMS key used for custody envelope encryption. Keep the custody encryption key configured so existing legacy rows remain readable.",
  },

  // Advanced (defaulted, collapsed)
  {
    key: "SDP_IMAGE_REGISTRY",
    section: "advanced",
    kind: "text",
    label: "Image registry",
    defaultValue: "ghcr.io/solana-foundation/sdp",
  },
  {
    key: "SDP_VERSION",
    section: "advanced",
    kind: "text",
    label: "Image version",
    defaultValue: "latest",
  },
  {
    key: "SDP_API_PORT",
    section: "advanced",
    kind: "text",
    label: "API port",
    defaultValue: "8787",
  },
  {
    key: "SDP_WEB_PORT",
    section: "advanced",
    kind: "text",
    label: "Web port",
    defaultValue: "3000",
  },
  {
    key: "SDP_DOCS_PORT",
    section: "advanced",
    kind: "text",
    label: "Docs port",
    defaultValue: "3001",
  },
  {
    key: "NEXT_PUBLIC_SDP_API_BASE_URL",
    section: "advanced",
    kind: "url",
    label: "Public API base URL",
    defaultValue: "http://localhost:8787",
  },
  {
    key: "NEXT_PUBLIC_SDP_API_URL",
    section: "advanced",
    kind: "url",
    label: "Public API URL",
    defaultValue: "http://localhost:8787",
  },
  {
    key: "NEXT_PUBLIC_SDP_WEB_URL",
    section: "advanced",
    kind: "url",
    label: "Public web URL",
    defaultValue: "http://localhost:3000",
  },
  {
    key: "NEXT_PUBLIC_SDP_DOCS_URL",
    section: "advanced",
    kind: "url",
    label: "Public docs URL",
    defaultValue: "http://localhost:3001",
  },
  {
    key: "TRUST_PROXY_HEADERS",
    section: "advanced",
    kind: "select",
    label: "Trust proxy headers",
    defaultValue: "false",
    options: [
      { value: "false", label: "Disabled" },
      { value: "true", label: "Enabled" },
      { value: "gclb", label: "Google Cloud load balancer" },
    ],
    help: "Enable only behind an ingress that replaces caller-supplied X-Forwarded-For headers, or pick the Google Cloud option when ingress is restricted to an external Application Load Balancer, which appends the verified client address instead. Direct deployments must leave this disabled.",
  },
  {
    key: "SDP_FLAG_ASSET_PROFILES",
    section: "advanced",
    kind: "select",
    label: "Asset Profiles production opt-in",
    defaultValue: "false",
    options: [
      { value: "false", label: "Disabled" },
      { value: "true", label: "Enabled" },
    ],
    help: "Development is always enabled. This setting controls production only.",
  },
  {
    key: "PRIVATE_CHANNELS_ENABLED",
    section: "advanced",
    kind: "select",
    label: "Private Channels enabled",
    defaultValue: "false",
    options: [
      { value: "false", label: "Disabled" },
      { value: "true", label: "Enabled" },
    ],
    help: "Gates Private Channels API routes and deposit/withdrawal reconcilers.",
  },
  {
    key: "PRIVATE_CHANNEL_EGRESS_ALLOWLIST",
    section: "advanced",
    kind: "text",
    label: "Private Channels egress allowlist",
    help: "Comma-separated origins (https://host[:port]) a project's Private Channels gateway or auth URL may point at. Projects supply those URLs, so anything not listed here is refused before SDP connects. The public sandbox is approved without configuring anything; a plaintext or loopback entry is honoured as written, so add one only for a destination you mean to approve.",
  },
  {
    key: "HELIUS_RINGS_ENABLED",
    section: "advanced",
    kind: "select",
    label: "Helius Rings enabled",
    defaultValue: "false",
    options: [
      { value: "false", label: "Disabled" },
      { value: "true", label: "Enabled" },
    ],
    help: "Gates the devnet-only Helius Rings shielded wallet API routes.",
  },
  {
    key: "SPC_CREDENTIAL_ENCRYPTION_KEY",
    section: "secrets",
    kind: "secret",
    secretEncoding: "base64",
    label: "SPC credential encryption key",
    help: "Base64-encoded 256-bit key for encrypting invited SPC user passwords. Separate from the custody key so compromising one cannot expose the other.",
  },
  {
    key: "SPC_CREDENTIAL_KMS_KEY_NAME",
    section: "secrets",
    kind: "text",
    label: "SPC credential Cloud KMS key name",
    pattern: /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/,
    help: "Optional Cloud KMS key used for SPC credential envelope encryption. Keep the SPC credential encryption key configured too: KMS authenticates through the GCE metadata server, so non-GCP deployments run on the key-in-environment path.",
  },
];

/** Keys that hold compose-only UI state and must NOT be emitted into the .env. */
export const UI_ONLY_KEYS = new Set([
  "DATABASE_MODE",
  "CACHE_MODE",
  "SIGNING_PROVIDERS",
  "POSTGRES_PASSWORD_MODE",
  "FEE_SPONSOR_CLUSTERS",
]);

/** A field is visible unless its visibleWhen predicate returns false. */
export function isFieldVisible(field: EnvField, values: Values): boolean {
  return field.visibleWhen ? field.visibleWhen(values) : true;
}
