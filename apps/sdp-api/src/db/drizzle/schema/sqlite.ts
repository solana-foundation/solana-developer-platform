import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Note: JSON blobs are stored as TEXT for D1 + Postgres portability.

export const organizations = sqliteTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    tier: text("tier").notNull().default("free"),
    status: text("status").notNull().default("active"),
    settings: text("settings"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => ({
    slugIdx: index("idx_organizations_slug").on(table.slug),
    statusIdx: index("idx_organizations_status").on(table.status),
  })
);

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    emailVerified: integer("email_verified").notNull().default(0),
    name: text("name"),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    lastLoginAt: text("last_login_at"),
    loginCount: integer("login_count").default(0),
  },
  (table) => ({
    emailIdx: index("idx_users_email").on(table.email),
    statusIdx: index("idx_users_status").on(table.status),
  })
);

export const authUserIdentities = sqliteTable(
  "auth_user_identities",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    email: text("email"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => ({
    providerUserUnique: uniqueIndex("auth_user_identities_provider_user_unique").on(
      table.provider,
      table.providerUserId
    ),
    userIdx: index("idx_auth_user_identities_user").on(table.userId),
    providerIdx: index("idx_auth_user_identities_provider").on(table.provider),
  })
);

export const authOrganizationIdentities = sqliteTable(
  "auth_organization_identities",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    providerOrgId: text("provider_org_id").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    slug: text("slug"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => ({
    providerOrgUnique: uniqueIndex("auth_org_identities_provider_org_unique").on(
      table.provider,
      table.providerOrgId
    ),
    orgIdx: index("idx_auth_org_identities_org").on(table.organizationId),
    providerIdx: index("idx_auth_org_identities_provider").on(table.provider),
  })
);

export const organizationMembers = sqliteTable(
  "organization_members",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => ({
    orgIdx: index("idx_org_members_org").on(table.organizationId),
    userIdx: index("idx_org_members_user").on(table.userId),
    orgUserUnique: uniqueIndex("organization_members_organization_id_user_id_unique").on(
      table.organizationId,
      table.userId
    ),
  })
);

export const allowlist = sqliteTable(
  "allowlist",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    value: text("value").notNull(),
    tier: text("tier").default("standard"),
    notes: text("notes"),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => ({
    typeValueIdx: index("idx_allowlist_type_value").on(table.type, table.value),
    typeValueUnique: uniqueIndex("allowlist_type_value_unique").on(table.type, table.value),
    statusIdx: index("idx_allowlist_status").on(table.status),
  })
);

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    userId: text("user_id"),
    apiKeyId: text("api_key_id"),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    metadata: text("metadata"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    requestId: text("request_id"),
    status: text("status").notNull().default("success"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => ({
    orgIdx: index("idx_audit_logs_org").on(table.organizationId),
    userIdx: index("idx_audit_logs_user").on(table.userId),
    createdIdx: index("idx_audit_logs_created").on(table.createdAt),
    actionIdx: index("idx_audit_logs_action").on(table.action),
  })
);

export const invitations = sqliteTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull().default("member"),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull(),
    expiresAt: text("expires_at").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => ({
    orgIdx: index("idx_invitations_org").on(table.organizationId),
    emailIdx: index("idx_invitations_email").on(table.email),
    tokenIdx: uniqueIndex("idx_invitations_token").on(table.tokenHash),
    statusIdx: index("idx_invitations_status").on(table.status),
  })
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    environment: text("environment").notNull().default("sandbox"),
    settings: text("settings"),
    status: text("status").notNull().default("active"),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => ({
    orgIdx: index("idx_projects_org").on(table.organizationId),
    statusIdx: index("idx_projects_status").on(table.status),
    slugIdx: index("idx_projects_slug").on(table.organizationId, table.slug),
    orgSlugUnique: uniqueIndex("projects_organization_id_slug_unique").on(
      table.organizationId,
      table.slug
    ),
  })
);

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    role: text("role").notNull().default("api_developer"),
    permissions: text("permissions"),
    environment: text("environment").notNull().default("sandbox"),
    rateLimitTier: text("rate_limit_tier").default("standard"),
    lastUsedAt: text("last_used_at"),
    expiresAt: text("expires_at"),
    revokedAt: text("revoked_at"),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    description: text("description"),
    allowedIps: text("allowed_ips"),
    rotatedFrom: text("rotated_from"),
    rotationDeadline: text("rotation_deadline"),
    signingWalletId: text("signing_wallet_id"),
  },
  (table) => ({
    orgIdx: index("idx_api_keys_org").on(table.organizationId),
    hashIdx: uniqueIndex("idx_api_keys_hash").on(table.keyHash),
    statusIdx: index("idx_api_keys_status").on(table.status),
    projectIdx: index("idx_api_keys_project").on(table.projectId),
    signingWalletIdx: index("idx_api_keys_signing_wallet_id").on(table.signingWalletId),
  })
);

export const apiKeyWalletPermissions = sqliteTable(
  "api_key_wallet_permissions",
  {
    id: text("id").primaryKey(),
    apiKeyId: text("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    walletId: text("wallet_id").notNull(),
    permissions: text("permissions").notNull().default('["*"]'),
    createdAt: text("created_at").notNull().default(sql`(STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => ({
    keyWalletUnique: uniqueIndex("idx_api_key_wallet_permissions_key_wallet").on(
      table.apiKeyId,
      table.walletId
    ),
    keyIdx: index("idx_api_key_wallet_permissions_key").on(table.apiKeyId),
  })
);

export const projectMembers = sqliteTable(
  "project_members",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("developer"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => ({
    projectIdx: index("idx_project_members_project").on(table.projectId),
    userIdx: index("idx_project_members_user").on(table.userId),
    projectUserUnique: uniqueIndex("project_members_project_id_user_id_unique").on(
      table.projectId,
      table.userId
    ),
  })
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    authMethod: text("auth_method").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    lastActivityAt: text("last_activity_at"),
  },
  (table) => ({
    userIdx: index("idx_sessions_user").on(table.userId),
    orgIdx: index("idx_sessions_org").on(table.organizationId),
    expiresIdx: index("idx_sessions_expires").on(table.expiresAt),
  })
);

export const magicLinks = sqliteTable(
  "magic_links",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull(),
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => ({
    emailIdx: index("idx_magic_links_email").on(table.email),
    tokenIdx: uniqueIndex("idx_magic_links_token").on(table.tokenHash),
    expiresIdx: index("idx_magic_links_expires").on(table.expiresAt),
  })
);

export const issuedTokens = sqliteTable(
  "issued_tokens",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    mintAddress: text("mint_address").unique(),
    mintAuthority: text("mint_authority"),
    freezeAuthority: text("freeze_authority"),
    name: text("name").notNull(),
    symbol: text("symbol").notNull(),
    decimals: integer("decimals").notNull().default(9),
    description: text("description"),
    uri: text("uri"),
    imageUrl: text("image_url"),
    totalSupply: text("total_supply_cached").notNull().default("0"),
    totalSupplyUpdatedAt: text("total_supply_updated_at"),
    maxSupply: text("max_supply"),
    isMintable: integer("is_mintable").default(1),
    isFreezable: integer("freeze_authority_enabled").default(1),
    requiresAllowlist: integer("allowlist_enabled").default(0),
    status: text("status").notNull().default("pending"),
    deployedAt: text("deployed_at"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`(STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'))`),
    template: text("template").notNull().default("custom"),
    ablListAddress: text("abl_list_address"),
  },
  (table) => ({
    projectIdx: index("idx_issued_tokens_project").on(table.projectId),
    orgIdx: index("idx_issued_tokens_org").on(table.organizationId),
    mintIdx: index("idx_issued_tokens_mint").on(table.mintAddress),
    statusIdx: index("idx_issued_tokens_status").on(table.status),
    templateIdx: index("idx_issued_tokens_template").on(table.template),
    ablListIdx: index("idx_issued_tokens_abl_list").on(table.ablListAddress),
  })
);

export const issuedTokenExtensions = sqliteTable(
  "issued_token_extensions",
  {
    id: text("id").primaryKey(),
    tokenId: text("token_id")
      .notNull()
      .references(() => issuedTokens.id, { onDelete: "cascade" }),
    extension: text("extension").notNull(),
    config: text("config"),
    createdAt: text("created_at").notNull().default(sql`(STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => ({
    tokenIdx: index("idx_issued_token_extensions_token").on(table.tokenId),
    tokenExtensionUnique: uniqueIndex("issued_token_extensions_token_id_extension_unique").on(
      table.tokenId,
      table.extension
    ),
  })
);

export const issuanceTransactions = sqliteTable(
  "issuance_transactions",
  {
    id: text("id").primaryKey(),
    tokenId: text("token_id")
      .notNull()
      .references(() => issuedTokens.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    status: text("status").notNull().default("pending"),
    idempotencyKey: text("idempotency_key"),
    idempotencyFingerprint: text("idempotency_fingerprint"),
    signature: text("signature"),
    serializedTx: text("serialized_tx"),
    operationParams: text("operation_params").notNull(),
    slot: integer("slot"),
    blockTime: text("block_time"),
    fee: integer("fee"),
    error: text("error"),
    initiatedByKeyId: text("initiated_by_key_id"),
    createdAt: text("created_at").notNull().default(sql`(STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => ({
    tokenIdx: index("idx_issuance_tx_token").on(table.tokenId),
    orgIdx: index("idx_issuance_tx_org").on(table.organizationId),
    statusIdx: index("idx_issuance_tx_status").on(table.status),
    signatureIdx: uniqueIndex("idx_issuance_tx_signature").on(table.signature),
    idempotencyIdx: uniqueIndex("idx_issuance_tx_org_idempotency_key").on(
      table.organizationId,
      table.idempotencyKey
    ),
  })
);

export const issuanceTransactionStatuses = sqliteTable(
  "issuance_transaction_statuses",
  {
    id: text("id").primaryKey(),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => issuanceTransactions.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    changedAt: text("changed_at").notNull().default(sql`(STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => ({
    transactionIdx: index("idx_issuance_tx_status_tx").on(table.transactionId),
    statusIdx: index("idx_issuance_tx_status_status").on(table.status),
  })
);

export const tokenAllowlists = sqliteTable(
  "token_allowlists",
  {
    id: text("id").primaryKey(),
    tokenId: text("token_id")
      .notNull()
      .references(() => issuedTokens.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    label: text("label"),
    status: text("status").notNull().default("active"),
    addedBy: text("added_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`(STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'))`),
    revokedAt: text("revoked_at"),
  },
  (table) => ({
    tokenIdx: index("idx_token_allowlist_token").on(table.tokenId),
    addressIdx: index("idx_token_allowlist_address").on(table.address),
    statusIdx: index("idx_token_allowlist_status").on(table.status),
    tokenAddressUnique: uniqueIndex("token_allowlists_token_id_address_unique").on(
      table.tokenId,
      table.address
    ),
  })
);

export const tokenAllowlistStatuses = sqliteTable(
  "token_allowlist_statuses",
  {
    id: text("id").primaryKey(),
    allowlistId: text("allowlist_id")
      .notNull()
      .references(() => tokenAllowlists.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    changedAt: text("changed_at").notNull().default(sql`(STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => ({
    allowlistIdx: index("idx_token_allowlist_statuses_entry").on(table.allowlistId),
    statusIdx: index("idx_token_allowlist_statuses_status").on(table.status),
  })
);

export const frozenAccounts = sqliteTable(
  "frozen_accounts",
  {
    id: text("id").primaryKey(),
    tokenId: text("token_id")
      .notNull()
      .references(() => issuedTokens.id, { onDelete: "cascade" }),
    accountAddress: text("account_address").notNull(),
    reason: text("reason"),
    frozenAt: text("frozen_at").notNull().default(sql`(STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'))`),
    frozenBy: text("frozen_by").notNull(),
    unfrozenAt: text("unfrozen_at"),
    unfrozenBy: text("unfrozen_by"),
  },
  (table) => ({
    tokenIdx: index("idx_frozen_accounts_token").on(table.tokenId),
    addressIdx: index("idx_frozen_accounts_address").on(table.accountAddress),
    tokenAccountUnique: uniqueIndex("frozen_accounts_token_id_account_address_unique").on(
      table.tokenId,
      table.accountAddress
    ),
  })
);

export const custodyConfigs = sqliteTable(
  "custody_configs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    configEncrypted: text("config_encrypted").notNull(),
    encryptionVersion: text("encryption_version").notNull().default("sdp-custody-encryption-v1"),
    defaultWalletId: text("default_wallet_id"),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull().default(sql`(STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => ({
    orgIdx: index("idx_custody_configs_org").on(table.organizationId),
    projectIdx: index("idx_custody_configs_project").on(table.organizationId, table.projectId),
    statusIdx: index("idx_custody_configs_status").on(table.status),
    orgProjectProviderUnique: uniqueIndex(
      "custody_configs_organization_id_project_id_provider_unique"
    ).on(table.organizationId, table.projectId, table.provider),
  })
);

export const signingRequests = sqliteTable(
  "signing_requests",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    custodyConfigId: text("custody_config_id").references(() => custodyConfigs.id, {
      onDelete: "set null",
    }),
    tokenTransactionId: text("token_transaction_id").references(() => issuanceTransactions.id, {
      onDelete: "set null",
    }),
    externalRequestId: text("external_request_id"),
    status: text("status").notNull().default("pending"),
    transactionMessage: text("transaction_message").notNull(),
    signatures: text("signatures"),
    metadata: text("metadata"),
    createdAt: text("created_at").notNull().default(sql`(STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'))`),
    completedAt: text("completed_at"),
  },
  (table) => ({
    statusIdx: index("idx_signing_requests_status").on(table.status),
    externalIdx: index("idx_signing_requests_external").on(table.externalRequestId),
    orgIdx: index("idx_signing_requests_org").on(table.organizationId),
    tokenTxIdx: index("idx_signing_requests_token_tx").on(table.tokenTransactionId),
  })
);

export const custodyWallets = sqliteTable(
  "custody_wallets",
  {
    id: text("id").primaryKey(),
    custodyConfigId: text("custody_config_id")
      .notNull()
      .references(() => custodyConfigs.id, { onDelete: "cascade" }),
    walletId: text("wallet_id").notNull(),
    publicKey: text("public_key").notNull(),
    label: text("label"),
    purpose: text("purpose"),
    status: text("status").notNull().default("active"),
    createdAt: text("created_at").notNull().default(sql`(STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => ({
    configIdx: index("idx_custody_wallets_config").on(table.custodyConfigId),
    publicKeyIdx: index("idx_custody_wallets_public_key").on(table.publicKey),
    configWalletUnique: uniqueIndex("custody_wallets_custody_config_id_wallet_id_unique").on(
      table.custodyConfigId,
      table.walletId
    ),
  })
);

export const custodyScopeDefaults = sqliteTable(
  "custody_scope_defaults",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    defaultCustodyConfigId: text("default_custody_config_id")
      .notNull()
      .references(() => custodyConfigs.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull().default(sql`(STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => ({
    orgProjectNotNullUnique: uniqueIndex("idx_custody_scope_defaults_org_project_not_null")
      .on(table.organizationId, table.projectId)
      .where(sql`${table.projectId} IS NOT NULL`),
    orgNullProjectUnique: uniqueIndex("idx_custody_scope_defaults_org_null_project")
      .on(table.organizationId)
      .where(sql`${table.projectId} IS NULL`),
    defaultConfigIdx: index("idx_custody_scope_defaults_default_config").on(
      table.defaultCustodyConfigId
    ),
  })
);

export const paymentWalletPolicies = sqliteTable(
  "payment_wallet_policies",
  {
    id: text("id").primaryKey(),
    custodyWalletId: text("custody_wallet_id")
      .notNull()
      .references(() => custodyWallets.id, { onDelete: "cascade" }),
    policyType: text("policy_type").notNull(),
    policy: text("policy").notNull(),
    createdAt: text("created_at").notNull().default(sql`(STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => ({
    walletPolicyTypeUnique: uniqueIndex(
      "payment_wallet_policies_custody_wallet_id_policy_type_unique"
    ).on(table.custodyWalletId, table.policyType),
    walletIdx: index("idx_payment_wallet_policies_wallet").on(table.custodyWalletId),
  })
);

export const paymentTransfers = sqliteTable(
  "payment_transfers",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    walletId: text("wallet_id").notNull(),
    sourceAddress: text("source_address").notNull(),
    destinationAddress: text("destination_address").notNull(),
    token: text("token").notNull(),
    amount: text("amount").notNull(),
    memo: text("memo"),
    type: text("type").notNull(),
    direction: text("direction").notNull(),
    status: text("status").notNull(),
    signature: text("signature"),
    serializedTx: text("serialized_tx"),
    slot: integer("slot"),
    blockTime: text("block_time"),
    fee: integer("fee"),
    error: text("error"),
    initiatedByKeyId: text("initiated_by_key_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => ({
    signatureUnique: uniqueIndex("payment_transfers_signature_unique").on(table.signature),
    orgCreatedIdx: index("idx_payment_transfers_org_created").on(
      table.organizationId,
      table.createdAt
    ),
    projectCreatedIdx: index("idx_payment_transfers_project_created").on(
      table.projectId,
      table.createdAt
    ),
    walletIdx: index("idx_payment_transfers_wallet").on(table.walletId),
    statusIdx: index("idx_payment_transfers_status").on(table.status),
  })
);
