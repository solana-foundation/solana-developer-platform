import type {
  ApiKeyWalletBinding,
  CachedSession,
  PrivateChannelEventReferencesEnvelope,
} from "@sdp/types";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { AppError } from "@/lib/errors";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type { Env } from "@/types/env";
import { listPrivateChannelEventReferences } from "./event-references";

const ORGANIZATION_ID = "org_event_refs_test";
const PROJECT_ID = "prj_event_refs_test";
const OTHER_PROJECT_ID = "prj_event_refs_other";
const USER_ID = "usr_event_refs_test";
const NON_MEMBER_USER_ID = "usr_event_refs_none";
const PRIVATE_CHANNEL_USER_ID = "pcu_event_refs_test";
const INSTANCE_ID = "pci_event_refs_test";
const CHANNEL_ID = "pch_event_refs_test";
const CUSTODY_CONFIG_ID = "ccfg_event_refs_test";
const CUSTODY_WALLET_ROW_ID = "cwlt_event_refs_test";
const WALLET_ID = "wallet_event_refs";
const PUBLIC_KEY = "RefsTreasuryPubkey11111111111111111111";
const OTHER_WALLET_ROW_ID = "cwlt_event_refs_other";
const OTHER_WALLET_ID = "wallet_event_refs_other";
const OTHER_PUBLIC_KEY = "RefsOtherPubkey1111111111111111111111";
const ISSUED_TOKEN_MINT = "RefsIssuedMint111111111111111111111111";

function attachErrorHandler(app: Hono<{ Bindings: Env }>) {
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toResponse(), err.statusCode as ContentfulStatusCode);
    }
    return c.json({ error: { code: "INTERNAL_ERROR", message: (err as Error).message } }, 500);
  });
  return app;
}

function buildApp(
  userId: string,
  permissions: CachedSession["permissions"] = ["payments:read", "wallets:read"]
) {
  const app = new Hono<{ Bindings: Env }>();
  const session: CachedSession = {
    id: `ses_${userId}`,
    userId,
    organizationId: ORGANIZATION_ID,
    permissions,
    expiresAt: "2099-01-01T00:00:00.000Z",
  };

  app.use("*", async (c, next) => {
    c.set("session", session);
    c.set("projectId", PROJECT_ID);
    await next();
  });
  app.get("/events/references", listPrivateChannelEventReferences);
  return attachErrorHandler(app);
}

function buildApiKeyApp(projectId: string, walletBindings: ApiKeyWalletBinding[] = []) {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", async (c, next) => {
    c.set("apiKey", {
      id: "key_event_refs_test",
      organizationId: ORGANIZATION_ID,
      projectId,
      role: "api_admin",
      permissions: ["*"],
      environment: "sandbox",
      signingWalletId: null,
      walletBindings,
    });
    c.set("projectId", PROJECT_ID);
    await next();
  });
  app.get("/events/references", listPrivateChannelEventReferences);
  return attachErrorHandler(app);
}

describe("Private Channels event references handler", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    const db = getDb(env);

    await db
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, 'Refs Org', 'refs-org', 'enterprise', 'active')"
      )
      .bind(ORGANIZATION_ID)
      .run();
    for (const [id, email, name] of [
      [USER_ID, "member@example.com", "Ada Lovelace"],
      [NON_MEMBER_USER_ID, "none@example.com", null],
    ] as const) {
      await db
        .prepare(
          "INSERT INTO users (id, email, name, email_verified, status) VALUES (?, ?, ?, 1, 'active')"
        )
        .bind(id, email, name)
        .run();
    }
    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Refs Project', 'refs-project', 'sandbox', 'active', ?)`
      )
      .bind(PROJECT_ID, ORGANIZATION_ID, USER_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO private_channel_instances
           (id, organization_id, project_id, gateway_url,
            escrow_program_id, withdraw_program_id, escrow_instance_addr, auth_url, is_active)
         VALUES (?, ?, ?, 'http://gw', 'prog1', 'prog2', 'escrow1', 'http://auth', true)`
      )
      .bind(INSTANCE_ID, ORGANIZATION_ID, PROJECT_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO private_channels
           (id, organization_id, project_id, instance_id, name, is_default, status)
         VALUES (?, ?, ?, ?, 'Treasury', true, 'active')`
      )
      .bind(CHANNEL_ID, ORGANIZATION_ID, PROJECT_ID, INSTANCE_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO private_channel_users (id, organization_id, project_id, user_id)
         VALUES (?, ?, ?, ?)`
      )
      .bind(PRIVATE_CHANNEL_USER_ID, ORGANIZATION_ID, PROJECT_ID, USER_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO private_channel_memberships
           (id, channel_id, private_channel_user_id, added_by)
         VALUES ('pcm_event_refs_test', ?, ?, ?)`
      )
      .bind(CHANNEL_ID, PRIVATE_CHANNEL_USER_ID, USER_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES (?, ?, ?, 'local', 'encrypted', 'active')`
      )
      .bind(CUSTODY_CONFIG_ID, ORGANIZATION_ID, PROJECT_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES
           (?, ?, ?, ?, 'Treasury Wallet', 'transfer', 'active'),
           (?, ?, ?, ?, 'Other Wallet', 'transfer', 'active')`
      )
      .bind(
        CUSTODY_WALLET_ROW_ID,
        CUSTODY_CONFIG_ID,
        WALLET_ID,
        PUBLIC_KEY,
        OTHER_WALLET_ROW_ID,
        CUSTODY_CONFIG_ID,
        OTHER_WALLET_ID,
        OTHER_PUBLIC_KEY
      )
      .run();
    await db
      .prepare(
        `INSERT INTO issued_tokens
           (id, project_id, organization_id, mint_address, name, symbol, decimals, status, created_by)
         VALUES ('tok_event_refs_test', ?, ?, ?, 'Refs Token', 'RFS', 6, 'active', ?)`
      )
      .bind(PROJECT_ID, ORGANIZATION_ID, ISSUED_TOKEN_MINT, USER_ID)
      .run();
  });

  it("returns an empty dictionary when the viewer has no user identity", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", async (c, next) => {
      c.set("session", {
        id: "ses_anonymous",
        userId: "",
        organizationId: ORGANIZATION_ID,
        permissions: ["payments:read"] as CachedSession["permissions"],
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      c.set("projectId", PROJECT_ID);
      await next();
    });
    app.get("/events/references", listPrivateChannelEventReferences);
    attachErrorHandler(app);

    const response = await app.request("/events/references", {}, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: PrivateChannelEventReferencesEnvelope };
    expect(body.data.references).toEqual({});
  });

  it("returns wallet labels but not channels for a user with no memberships", async () => {
    const app = buildApp(NON_MEMBER_USER_ID);
    const response = await app.request("/events/references", {}, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: PrivateChannelEventReferencesEnvelope };
    expect(body.data.references[PUBLIC_KEY]).toBe("Treasury Wallet");
    expect(body.data.references[CHANNEL_ID]).toBeUndefined();
    expect(body.data.references[INSTANCE_ID]).toBeUndefined();
  });

  it("returns channel, wallet, member, token, and instance names for a project member", async () => {
    const app = buildApp(USER_ID);
    const response = await app.request("/events/references", {}, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: PrivateChannelEventReferencesEnvelope };
    expect(body.data.references[CHANNEL_ID]).toBe("Treasury");
    expect(body.data.references[PUBLIC_KEY]).toBe("Treasury Wallet");
    expect(body.data.references[WALLET_ID]).toBe("Treasury Wallet");
    expect(body.data.references[PRIVATE_CHANNEL_USER_ID]).toBe("Ada Lovelace");
    expect(body.data.references[USER_ID]).toBe("Ada Lovelace");
    expect(body.data.references[ISSUED_TOKEN_MINT]).toBe("RFS");
    expect(body.data.references[INSTANCE_ID]).toBe("http://gw");
  });

  it("omits wallet labels for a caller without wallets:read", async () => {
    const app = buildApp(USER_ID, ["payments:read"]);
    const response = await app.request("/events/references", {}, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: PrivateChannelEventReferencesEnvelope };
    expect(body.data.references[PUBLIC_KEY]).toBeUndefined();
    expect(body.data.references[WALLET_ID]).toBeUndefined();
    expect(body.data.references[CHANNEL_ID]).toBe("Treasury");
  });

  it("returns the full dictionary, gateway URL included, for projects:write viewers", async () => {
    const app = buildApp(NON_MEMBER_USER_ID, ["payments:read", "projects:write"]);
    const response = await app.request("/events/references", {}, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: PrivateChannelEventReferencesEnvelope };
    expect(body.data.references[CHANNEL_ID]).toBe("Treasury");
    expect(body.data.references[PRIVATE_CHANNEL_USER_ID]).toBe("Ada Lovelace");
    expect(body.data.references[INSTANCE_ID]).toBe("http://gw");
  });

  it("rejects an API key scoped to another project", async () => {
    const app = buildApiKeyApp(OTHER_PROJECT_ID);
    const response = await app.request("/events/references", {}, env);
    expect(response.status).toBe(403);
  });

  it("returns the full dictionary for a correctly scoped API key", async () => {
    const app = buildApiKeyApp(PROJECT_ID);
    const response = await app.request("/events/references", {}, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: PrivateChannelEventReferencesEnvelope };
    expect(body.data.references[CHANNEL_ID]).toBe("Treasury");
    expect(body.data.references[PUBLIC_KEY]).toBe("Treasury Wallet");
  });

  it("limits wallet labels to the API key wallet bindings", async () => {
    const app = buildApiKeyApp(PROJECT_ID, [
      { walletId: WALLET_ID, permissions: ["wallets:read"] },
    ]);
    const response = await app.request("/events/references", {}, env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: PrivateChannelEventReferencesEnvelope };
    expect(body.data.references[PUBLIC_KEY]).toBe("Treasury Wallet");
    expect(body.data.references[WALLET_ID]).toBe("Treasury Wallet");
    expect(body.data.references[OTHER_PUBLIC_KEY]).toBeUndefined();
    expect(body.data.references[OTHER_WALLET_ID]).toBeUndefined();
  });
});
