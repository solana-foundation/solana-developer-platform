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
  {
    key: "EMAIL_FROM",
    section: "basic",
    kind: "text",
    label: "Email from address",
    help: "Optional sender address for transactional email.",
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
    key: "SOLANA_NETWORK",
    section: "rpc",
    kind: "select",
    label: "Network",
    defaultValue: "devnet",
    options: [
      { value: "devnet", label: "devnet" },
      { value: "mainnet-beta", label: "mainnet-beta" },
    ],
  },
  {
    key: "SOLANA_RPC_URL",
    section: "rpc",
    kind: "url",
    label: "RPC URL",
    defaultValue: "https://api.devnet.solana.com",
    required: true,
    pattern: /^https:\/\//,
  },
  {
    key: "SOLANA_RPC_HELIUS_API_KEY",
    section: "rpc",
    kind: "password",
    label: "Helius API key",
    visibleWhen: (v) => v.SOLANA_RPC_URL?.includes("helius") ?? false,
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
    key: "CLERK_JWT_TEMPLATE",
    section: "clerk",
    kind: "text",
    label: "JWT template name",
    defaultValue: "sdp-api",
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
    label: "Signing providers",
    defaultValue: "local",
    required: true,
    options: SIGNING_PROVIDER_OPTIONS,
    help: "Providers to prepare credentials for in this .env. The runtime default is chosen below; orgs/projects can later activate any configured provider from the dashboard.",
  },
  {
    key: "SIGNING_PROVIDER",
    section: "signing",
    kind: "select",
    label: "Default signing provider",
    defaultValue: "local",
    required: true,
    optionsWhen: (v) =>
      parseList(v.SIGNING_PROVIDERS).map(
        (p) => SIGNING_PROVIDER_OPTIONS.find((o) => o.value === p) ?? { value: p, label: p }
      ),
    help: "Global fallback provider, used when an org/project has no custody config of its own.",
  },
  {
    key: "CUSTODY_PRIVATE_KEY",
    section: "signing",
    kind: "password",
    label: "Signing key (base58)",
    required: true,
    visibleWhen: listIncludes("SIGNING_PROVIDERS", "local"),
    help: "Base58 private key the local signer uses. Generate one and fund it on your network.",
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
    key: "FIREBLOCKS_VAULT_ID",
    section: "signing",
    kind: "text",
    label: "Fireblocks vault ID",
    required: true,
    visibleWhen: listIncludes("SIGNING_PROVIDERS", "fireblocks"),
  },
  {
    key: "PRIVY_APP_ID",
    section: "signing",
    kind: "text",
    label: "Privy app ID",
    required: true,
    visibleWhen: listIncludes("SIGNING_PROVIDERS", "privy"),
  },
  {
    key: "PRIVY_APP_SECRET",
    section: "signing",
    kind: "password",
    label: "Privy app secret",
    required: true,
    visibleWhen: listIncludes("SIGNING_PROVIDERS", "privy"),
  },
  {
    key: "PRIVY_WALLET_ID",
    section: "signing",
    kind: "text",
    label: "Privy wallet ID",
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
    key: "COINBASE_CDP_WALLET_ID",
    section: "signing",
    kind: "text",
    label: "Coinbase CDP wallet ID",
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
    key: "PARA_WALLET_ID",
    section: "signing",
    kind: "text",
    label: "Para wallet ID",
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
    key: "TURNKEY_PRIVATE_KEY_ID",
    section: "signing",
    kind: "text",
    label: "Turnkey private key ID",
    required: true,
    visibleWhen: listIncludes("SIGNING_PROVIDERS", "turnkey"),
  },
  {
    key: "TURNKEY_PUBLIC_KEY",
    section: "signing",
    kind: "text",
    label: "Turnkey public key",
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
    key: "UTILA_WALLET_ID",
    section: "signing",
    kind: "text",
    label: "Utila wallet ID",
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

  // Fee
  {
    key: "FEE_PAYMENT_PROVIDER",
    section: "fee",
    kind: "select",
    label: "Fee payment",
    defaultValue: "native",
    options: [
      { value: "native", label: "native" },
      { value: "kora", label: "kora" },
    ],
  },
  {
    key: "FEE_PAYER_PRIVATE_KEY",
    section: "fee",
    kind: "password",
    label: "Fee payer key (base58)",
    required: true,
    visibleWhen: (v) => v.FEE_PAYMENT_PROVIDER === "native" && v.SIGNING_PROVIDER !== "local",
    help: "Base58 keypair that pays transaction fees. Required because a managed signing provider is selected; with local signing the signing key is used instead.",
  },
  {
    key: "KORA_RPC_URL",
    section: "fee",
    kind: "url",
    label: "Kora RPC URL",
    pattern: /^https?:\/\//,
    visibleWhen: isProvider("FEE_PAYMENT_PROVIDER", "kora"),
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
    key: "CUSTODY_ENCRYPTION_KEY",
    section: "secrets",
    kind: "secret",
    secretEncoding: "base64",
    label: "Custody encryption key",
    required: true,
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
    key: "NEXT_PUBLIC_SOLANA_NETWORK",
    section: "advanced",
    kind: "text",
    label: "Public Solana network",
    derive: (v) => v.SOLANA_NETWORK ?? "devnet",
  },
  {
    key: "PAYMENTS_RECURRING_ENABLED",
    section: "advanced",
    kind: "text",
    label: "Recurring payments enabled",
    defaultValue: "false",
  },
  {
    key: "SENTRY_DSN",
    section: "advanced",
    kind: "url",
    label: "Sentry DSN",
    help: "Optional error reporting. Leave blank to disable Sentry.",
  },
];

/** Keys that hold compose-only UI state and must NOT be emitted into the .env. */
export const UI_ONLY_KEYS = new Set([
  "DATABASE_MODE",
  "CACHE_MODE",
  "SIGNING_PROVIDERS",
  "POSTGRES_PASSWORD_MODE",
]);

/** A field is visible unless its visibleWhen predicate returns false. */
export function isFieldVisible(field: EnvField, values: Values): boolean {
  return field.visibleWhen ? field.visibleWhen(values) : true;
}
