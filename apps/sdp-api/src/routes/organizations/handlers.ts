import { getAuth } from "@/lib/auth";
import { AppError, conflict, notFound } from "@/lib/errors";
import { hashString } from "@/lib/hash";
import { created, noContent, success } from "@/lib/response";
import { createAllowlistService } from "@/services/allowlist.service";
import { AuditService } from "@/services/audit.service";
import {
  provisionCoinbaseCdpAccount,
  provisionFireblocksVaultAccount,
  provisionParaWallet,
  provisionTurnkeyPrivateKey,
} from "@/services/custody/provisioning";
import { createSigningService } from "@/services/domain/signing.service";
import { KVService } from "@/services/kv.service";
import { SigningError } from "@/services/ports";
import type { Env } from "@/types/env";
import {
  type CreateOrganizationResponse,
  ORGANIZATION_STATUSES,
  ORGANIZATION_TIERS,
  type Organization,
  type OrganizationSettings,
  type OrganizationStatus,
  type OrganizationTier,
} from "@sdp/types";
import type { Context } from "hono";
import { createOrgSchema, updateOrgSchema } from "./schemas";

type AppContext = Context<{ Bindings: Env }>;

type OrganizationRow = {
  id: string;
  name: string;
  slug: string;
  tier: string;
  status: string;
  settings: string | null;
  created_at: string;
  updated_at: string;
};

function parseOrganizationSettings(raw: string | null): OrganizationSettings | null {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as OrganizationSettings;
  } catch {
    return null;
  }
}

function parseOrganizationTier(value: string): OrganizationTier {
  if (ORGANIZATION_TIERS.includes(value as OrganizationTier)) {
    return value as OrganizationTier;
  }
  throw new AppError("INTERNAL_ERROR", `Organization tier '${value}' is invalid`);
}

function parseOrganizationStatus(value: string): OrganizationStatus {
  if (ORGANIZATION_STATUSES.includes(value as OrganizationStatus)) {
    return value as OrganizationStatus;
  }
  throw new AppError("INTERNAL_ERROR", `Organization status '${value}' is invalid`);
}

function resolveOrganizationTierFromAllowlist(value: string): OrganizationTier {
  if (value === "standard") {
    return "free";
  }
  return parseOrganizationTier(value);
}

function toOrganizationResponse(row: OrganizationRow): Organization {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    tier: parseOrganizationTier(row.tier),
    status: parseOrganizationStatus(row.status),
    settings: parseOrganizationSettings(row.settings),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);

  const globalWithBuffer = globalThis as {
    Buffer?: {
      from: (input: Uint8Array) => { toString: (encoding: "base64") => string };
    };
  };

  if (globalWithBuffer.Buffer) {
    return globalWithBuffer.Buffer.from(bytes)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function createApiKeyMaterial(environment: "sandbox" | "production"): {
  key: string;
  prefix: string;
} {
  const envPrefix = environment === "production" ? "live" : "test";
  const randomPart = randomBase64Url(24);
  const key = `sk_${envPrefix}_${randomPart}`;
  const prefix = `sk_${envPrefix}_${randomPart.slice(0, 3)}`;
  return { key, prefix };
}

async function cleanupCustodyForOrg(env: Env, orgId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM custody_wallets
       WHERE custody_config_id IN (
         SELECT id FROM custody_configs WHERE organization_id = ?
       )`
    ).bind(orgId),
    env.DB.prepare("DELETE FROM custody_configs WHERE organization_id = ?").bind(orgId),
  ]);
}

export const createOrganization = async (c: AppContext) => {
  const body = await c.req.json();
  const parsed = createOrgSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const { name, email, custody, returnFullApiKey } = parsed.data;
  const registrationTokenHeader = c.req.header("x-organization-registration-token");
  const registrationToken = c.env.ORGANIZATION_REGISTRATION_TOKEN;
  const slug = parsed.data.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

  // Initialize services
  const allowlistService = createAllowlistService(c.env);
  const auditService = new AuditService(c.env.DB);

  // Organization self-registration is gated by a required pre-shared token.
  if (!registrationToken) {
    throw new AppError("FORBIDDEN", "Organization self-registration is disabled");
  }

  if (!registrationTokenHeader || registrationTokenHeader !== registrationToken) {
    throw new AppError("FORBIDDEN", "Invalid or missing registration token");
  }

  // Check allowlist
  const { allowed, tier } = await allowlistService.isEmailAllowed(email);
  if (!allowed) {
    throw new AppError("NOT_ALLOWLISTED", "Email or domain not on allowlist");
  }
  const resolvedTier = resolveOrganizationTierFromAllowlist(tier);

  // Check if slug is taken
  const existing = await c.env.DB.prepare("SELECT id FROM organizations WHERE slug = ?")
    .bind(slug)
    .first();

  if (existing) {
    throw conflict("Organization with this slug already exists");
  }

  // Create organization
  const orgId = `org_${crypto.randomUUID()}`;
  const userId = `usr_${crypto.randomUUID()}`;
  const memberId = `mem_${crypto.randomUUID()}`;
  const apiKeyId = `key_${crypto.randomUUID()}`;

  if (custody) {
    const signingService = createSigningService(c.env);

    try {
      if (custody.provider === "fireblocks") {
        const { vaultAccountId, assetId } = await provisionFireblocksVaultAccount(c.env, {
          orgId,
          orgSlug: slug,
          assetId: custody.assetId,
          apiBaseUrl: custody.apiBaseUrl,
          vaultAccountId: custody.vaultAccountId,
        });

        if (!c.env.FIREBLOCKS_API_KEY || !c.env.FIREBLOCKS_API_SECRET) {
          throw new SigningError(
            "Fireblocks environment variables not configured: FIREBLOCKS_API_KEY, FIREBLOCKS_API_SECRET",
            "PROVIDER_NOT_CONFIGURED"
          );
        }

        await signingService.initializeFireblocksSigning(orgId, undefined, {
          apiKey: c.env.FIREBLOCKS_API_KEY,
          apiSecretPem: c.env.FIREBLOCKS_API_SECRET,
          vaultAccountId,
          assetId,
          apiBaseUrl: custody.apiBaseUrl ?? c.env.FIREBLOCKS_API_BASE_URL,
        });
      } else if (custody.provider === "coinbase_cdp") {
        const provisioned = await provisionCoinbaseCdpAccount(c.env, {
          orgId,
          orgSlug: slug,
          apiBaseUrl: custody.apiBaseUrl,
          network: custody.network,
          walletAddress: custody.walletAddress,
          accountPolicy: custody.accountPolicy,
        });

        await signingService.initializeCoinbaseCdpSigning(orgId, undefined, {
          apiBaseUrl: custody.apiBaseUrl ?? c.env.COINBASE_CDP_API_BASE_URL,
          network: custody.network ?? c.env.COINBASE_CDP_NETWORK,
          walletAddress: provisioned.address,
          accountPolicy: custody.accountPolicy,
        });
      } else if (custody.provider === "para") {
        const provisioned = await provisionParaWallet(c.env, {
          orgId,
          orgSlug: slug,
          apiBaseUrl: custody.apiBaseUrl,
          walletId: custody.walletId,
        });

        await signingService.initializeParaSigning(orgId, undefined, {
          apiBaseUrl: custody.apiBaseUrl ?? c.env.PARA_API_BASE_URL,
          requestDelayMs: custody.requestDelayMs,
          walletId: provisioned.walletId,
        });
      } else if (custody.provider === "turnkey") {
        const provisioned = await provisionTurnkeyPrivateKey(c.env, {
          orgId,
          orgSlug: slug,
          apiBaseUrl: custody.apiBaseUrl,
          privateKeyId: custody.privateKeyId,
        });

        await signingService.initializeTurnkeySigning(orgId, undefined, {
          apiBaseUrl: custody.apiBaseUrl ?? c.env.TURNKEY_API_BASE_URL,
          requestDelayMs: custody.requestDelayMs,
          privateKeyId: provisioned.privateKeyId,
        });
      } else if (custody.provider === "dfns") {
        await signingService.initializeDfnsSigning(orgId, undefined, {
          apiBaseUrl: custody.apiBaseUrl ?? c.env.DFNS_API_BASE_URL,
          network: custody.network,
          walletId: custody.walletId,
          signingKeyId: custody.signingKeyId,
        });
      } else if (custody.provider === "anchorage") {
        await signingService.initializeAnchorageSigning(orgId, undefined, {
          apiBaseUrl: custody.apiBaseUrl ?? c.env.ANCHORAGE_API_BASE_URL,
          walletId: custody.walletId,
          network: custody.network,
        });
      } else {
        await signingService.initializePrivySigning(orgId, undefined, {
          apiBaseUrl: custody.apiBaseUrl ?? c.env.PRIVY_API_BASE_URL,
          requestDelayMs: custody.requestDelayMs,
        });
      }
    } catch (error) {
      await cleanupCustodyForOrg(c.env, orgId);
      const message = error instanceof Error ? error.message : "Custody initialization failed";
      throw new AppError("BAD_REQUEST", message);
    }
  }

  // Generate API key
  const { key, prefix } = createApiKeyMaterial("sandbox");
  const keyHash = await hashString(key, c.env.API_KEY_PEPPER);

  // Insert all records in a batch
  const batch = [
    // Organization
    c.env.DB.prepare(
      `INSERT INTO organizations (id, name, slug, tier, status)
       VALUES (?, ?, ?, ?, 'active')`
    ).bind(orgId, name, slug, resolvedTier),

    // User
    c.env.DB.prepare(
      `INSERT INTO users (id, email, email_verified, status)
       VALUES (?, ?, 0, 'active')`
    ).bind(userId, email.toLowerCase()),

    // Organization member (owner)
    c.env.DB.prepare(
      `INSERT INTO organization_members (id, organization_id, user_id, role, status)
       VALUES (?, ?, ?, 'owner', 'active')`
    ).bind(memberId, orgId, userId),

    // API key
    c.env.DB.prepare(
      `INSERT INTO api_keys (id, organization_id, created_by, name, key_prefix, key_hash, role, environment, status)
       VALUES (?, ?, ?, 'Default Key', ?, ?, 'api_admin', 'sandbox', 'active')`
    ).bind(apiKeyId, orgId, userId, prefix, keyHash),
  ];

  try {
    await c.env.DB.batch(batch);
  } catch (error) {
    if (custody) {
      await cleanupCustodyForOrg(c.env, orgId);
    }
    throw error;
  }

  // Audit log
  await auditService.log(c, {
    organizationId: orgId,
    userId,
    action: "create",
    resourceType: "organization",
    resourceId: orgId,
    metadata: { name, slug, email },
  });

  const response: CreateOrganizationResponse = {
    organization: {
      id: orgId,
      name,
      slug,
      tier: resolvedTier,
      status: "active",
      settings: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    apiKey: {
      id: apiKeyId,
      keyPrefix: prefix,
      ...(returnFullApiKey ? { key } : {}),
    },
  };

  return created(c, response);
};

export const getOrganization = async (c: AppContext) => {
  const { orgId } = c.req.param();
  const auth = getAuth(c);

  // Verify access to this organization
  if (auth?.organizationId !== orgId) {
    throw new AppError("FORBIDDEN", "Access denied to this organization");
  }

  const org = await c.env.DB.prepare(
    `SELECT id, name, slug, tier, status, settings, created_at, updated_at
     FROM organizations WHERE id = ?`
  )
    .bind(orgId)
    .first<OrganizationRow>();

  if (!org) {
    throw notFound("Organization");
  }

  const response = toOrganizationResponse(org);

  return success(c, response);
};

export const updateOrganization = async (c: AppContext) => {
  const { orgId } = c.req.param();
  const auth = getAuth(c);

  if (auth?.organizationId !== orgId) {
    throw new AppError("FORBIDDEN", "Access denied to this organization");
  }

  const body = await c.req.json();
  const parsed = updateOrgSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const updates: string[] = [];
  const params: (string | null)[] = [];

  const existing = await c.env.DB.prepare(
    `SELECT id, name, slug, tier, status, settings, created_at, updated_at
     FROM organizations WHERE id = ?`
  )
    .bind(orgId)
    .first<OrganizationRow>();

  if (!existing) {
    throw notFound("Organization");
  }

  if (parsed.data.name) {
    updates.push("name = ?");
    params.push(parsed.data.name);
  }

  if (parsed.data.settings !== undefined) {
    const mergedSettings: OrganizationSettings = {
      ...(parseOrganizationSettings(existing.settings) ?? {}),
      ...parsed.data.settings,
    };
    updates.push("settings = ?");
    params.push(JSON.stringify(mergedSettings));
  }

  if (updates.length === 0) {
    throw new AppError("BAD_REQUEST", "No valid updates provided");
  }

  updates.push("updated_at = datetime('now')");
  params.push(orgId);

  await c.env.DB.prepare(`UPDATE organizations SET ${updates.join(", ")} WHERE id = ?`)
    .bind(...params)
    .run();

  // Invalidate cache
  const kvService = new KVService(c.env.SDP_API_KEYS, c.env.SDP_CACHE);
  await kvService.invalidateOrganization(orgId);

  // Fetch updated org
  const org = await c.env.DB.prepare(
    `SELECT id, name, slug, tier, status, settings, created_at, updated_at
     FROM organizations WHERE id = ?`
  )
    .bind(orgId)
    .first<OrganizationRow>();

  // Audit log
  const auditService = new AuditService(c.env.DB);
  await auditService.log(c, {
    action: "update",
    resourceType: "organization",
    resourceId: orgId,
    metadata: parsed.data,
  });

  if (!org) {
    throw notFound("Organization");
  }

  return success(c, toOrganizationResponse(org));
};

export const deleteOrganization = async (c: AppContext) => {
  const { orgId } = c.req.param();
  const auth = getAuth(c);

  if (auth?.organizationId !== orgId) {
    throw new AppError("FORBIDDEN", "Access denied to this organization");
  }

  // Soft delete
  await c.env.DB.prepare(
    `UPDATE organizations SET status = 'deleted', updated_at = datetime('now') WHERE id = ?`
  )
    .bind(orgId)
    .run();

  // Revoke all API keys
  await c.env.DB.prepare(
    `UPDATE api_keys SET status = 'revoked', revoked_at = datetime('now') WHERE organization_id = ?`
  )
    .bind(orgId)
    .run();

  // Invalidate cache
  const kvService = new KVService(c.env.SDP_API_KEYS, c.env.SDP_CACHE);
  await kvService.invalidateOrganization(orgId);

  // Audit log
  const auditService = new AuditService(c.env.DB);
  await auditService.log(c, {
    action: "delete",
    resourceType: "organization",
    resourceId: orgId,
  });

  return noContent(c);
};
