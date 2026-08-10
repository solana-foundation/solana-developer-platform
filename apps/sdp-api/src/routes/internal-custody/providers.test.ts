import type { CustodySetupStatusResponse } from "@sdp/types";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import type { ClerkJwtPayload } from "@/lib/clerk-token";
import { AppError } from "@/lib/errors";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";
import type { Env } from "@/types/env";
import internalCustody from "./index";

const TEST_ORG = {
  id: "org_custody_setup_status",
  name: "Custody Setup Status Org",
  slug: "custody-setup-status-org",
  clerkId: "clerk_org_custody_setup_status",
};

const TEST_PROJECT = {
  id: "prj_custody_setup_status",
  slug: "custody-setup-status-project",
};

const TEST_USER = {
  id: "usr_custody_setup_status",
  email: "custody-setup-status@example.com",
  clerkId: "clerk_custody_setup_status",
};

const CREDENTIAL_ID = "pcred_setup_status_privy";

function encodeJwtPart(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createJwt(payload: ClerkJwtPayload): string {
  return `${encodeJwtPart({ alg: "RS256", typ: "JWT" })}.${encodeJwtPart(payload)}.signature`;
}

function buildApp(options: { injectJwt?: boolean } = {}) {
  const payload: ClerkJwtPayload = {
    sub: TEST_USER.clerkId,
    org_id: TEST_ORG.clerkId,
    org_role: "org:admin",
    email: TEST_USER.email,
  };
  const token = createJwt(payload);
  const app = new Hono<{ Bindings: Env }>();

  app.use("*", kvStoreMiddleware());
  app.use("*", async (c, next) => {
    if (options.injectJwt !== false) {
      c.set("verifiedClerkJwt", { token, payload });
    }
    c.set("requestId", "req_custody_setup_status");
    await next();
  });
  app.route("/internal/dashboard/custody", internalCustody);
  app.onError((error, c) => {
    if (error instanceof AppError) {
      return c.json(
        { error: error.toResponse().error, meta: { requestId: c.get("requestId") } },
        error.statusCode as 400
      );
    }
    throw error;
  });

  return { app, token };
}

async function seedBaseline(): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, "enterprise", "active"),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(TEST_USER.id, TEST_USER.email, 1, "active"),
    db
      .prepare(
        `INSERT INTO auth_user_identities (id, provider, provider_user_id, user_id, email)
         VALUES (?, 'clerk', ?, ?, ?)`
      )
      .bind("aui_custody_setup_status", TEST_USER.clerkId, TEST_USER.id, TEST_USER.email),
    db
      .prepare(
        `INSERT INTO auth_organization_identities (id, provider, provider_org_id, organization_id, slug)
         VALUES (?, 'clerk', ?, ?, ?)`
      )
      .bind("aoi_custody_setup_status", TEST_ORG.clerkId, TEST_ORG.id, TEST_ORG.slug),
    db
      .prepare(
        `INSERT INTO organization_members (id, organization_id, user_id, role, status)
         VALUES (?, ?, ?, 'admin', 'active')`
      )
      .bind("mem_custody_setup_status", TEST_ORG.id, TEST_USER.id),
    db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, 'sandbox', 'active', ?)`
      )
      .bind(TEST_PROJECT.id, TEST_ORG.id, "Setup Status Project", TEST_PROJECT.slug, TEST_USER.id),
    db
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role)
         VALUES (?, ?, ?, 'admin')`
      )
      .bind("pm_custody_setup_status", TEST_PROJECT.id, TEST_USER.id),
  ]);
}

async function seedLegacyConfig(provider: string, configId: string): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO custody_configs
         (id, organization_id, project_id, provider, config_encrypted, encryption_version, default_wallet_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      configId,
      TEST_ORG.id,
      TEST_PROJECT.id,
      provider,
      "test-config",
      "sdp-custody-encryption-v1",
      null,
      "active"
    )
    .run();
}

async function seedCredential(): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO provider_credentials
         (id, organization_id, project_id, provider, label, scope, source, storage_backend,
          encrypted_secret_payload, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      CREDENTIAL_ID,
      TEST_ORG.id,
      TEST_PROJECT.id,
      "privy",
      "Privy credential",
      "project",
      "stored",
      "encrypted_db",
      "encrypted-test-payload",
      "active"
    )
    .run();
}

async function seedConnection(id: string, status: string): Promise<void> {
  await getDb(env)
    .prepare(
      `INSERT INTO custody_connections
         (id, organization_id, project_id, provider, scope, provider_credential_id,
          provider_credential_scope_key, status, activated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      TEST_ORG.id,
      TEST_PROJECT.id,
      "privy",
      "project",
      CREDENTIAL_ID,
      TEST_PROJECT.id,
      status,
      // The schema requires an activation timestamp on an active connection.
      status === "active" ? "2026-08-05T00:00:00.000Z" : null
    )
    .run();
}

async function fetchSetupStatus(): Promise<CustodySetupStatusResponse> {
  const { app, token } = buildApp();
  const response = await app.request(
    "/internal/dashboard/custody/providers",
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Project-ID": TEST_PROJECT.id,
      },
    },
    env
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: CustodySetupStatusResponse };
  return body.data;
}

function statusFor(response: CustodySetupStatusResponse, provider: string) {
  return response.providers.find((entry) => entry.provider === provider);
}

describe("internal custody providers", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedBaseline();
  });

  afterEach(async () => {
    await clearKVStores(env);
  });

  it("refuses a caller with no dashboard session", async () => {
    const { app } = buildApp({ injectJwt: false });
    const response = await app.request(
      "/internal/dashboard/custody/providers",
      { headers: { "X-Project-ID": TEST_PROJECT.id } },
      env
    );
    expect(response.status).toBeGreaterThanOrEqual(401);
  });

  it("reports a provider with no rows as installable rather than installed", async () => {
    const status = await fetchSetupStatus();
    const privy = statusFor(status, "privy");

    expect(privy?.hasLegacyConfig).toBe(false);
    expect(privy?.effectiveTargetType).toBe("none");
    expect(privy?.connectionCounts).toEqual({
      pending: 0,
      checking: 0,
      active: 0,
      failed: 0,
      deactivated: 0,
    });
  });

  it("covers every known provider so the caller never has to guess", async () => {
    const status = await fetchSetupStatus();

    expect(status.providers.map((entry) => entry.provider)).toContain("fireblocks");
    expect(status.providers.length).toBeGreaterThanOrEqual(10);
  });

  it("reports every provider with a reachable config, not only the scope default", async () => {
    // Signing targeted at a specific provider resolves through that provider's
    // config regardless of which one is the scope default; default-ness is the
    // configs resource's fact, not this endpoint's.
    await seedLegacyConfig("privy", "cust_cfg_setup_status_multi_privy");
    await seedLegacyConfig("para", "cust_cfg_setup_status_multi_para");

    const status = await fetchSetupStatus();
    expect(statusFor(status, "privy")?.effectiveTargetType).toBe("config");
    expect(statusFor(status, "para")?.effectiveTargetType).toBe("config");
  });

  it("reports an active legacy config as a config-backed target", async () => {
    await seedLegacyConfig("privy", "cust_cfg_setup_status_privy");

    const privy = statusFor(await fetchSetupStatus(), "privy");
    expect(privy?.hasLegacyConfig).toBe(true);
    expect(privy?.effectiveTargetType).toBe("config");
  });

  it("ignores an inactive legacy config", async () => {
    await getDb(env)
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, encryption_version, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "cust_cfg_setup_status_inactive",
        TEST_ORG.id,
        TEST_PROJECT.id,
        "privy",
        "test-config",
        "sdp-custody-encryption-v1",
        "inactive"
      )
      .run();

    const privy = statusFor(await fetchSetupStatus(), "privy");
    expect(privy?.hasLegacyConfig).toBe(false);
    expect(privy?.effectiveTargetType).toBe("none");
  });

  it("counts connections by lifecycle without listing them", async () => {
    await seedCredential();
    await seedConnection("ccon_setup_status_pending", "pending");
    await seedConnection("ccon_setup_status_failed", "failed");

    const privy = statusFor(await fetchSetupStatus(), "privy");
    expect(privy?.connectionCounts.pending).toBe(1);
    expect(privy?.connectionCounts.failed).toBe(1);
    expect(privy?.connectionCounts.active).toBe(0);
    // A pending connection is not yet a signing target.
    expect(privy?.effectiveTargetType).toBe("none");
    expect(JSON.stringify(privy)).not.toContain("ccon_setup_status_pending");
  });

  it("keeps reporting the config while signing still resolves through it", async () => {
    await seedLegacyConfig("privy", "cust_cfg_setup_status_both");
    await seedCredential();
    await seedConnection("ccon_setup_status_active", "active");

    const privy = statusFor(await fetchSetupStatus(), "privy");
    expect(privy?.hasLegacyConfig).toBe(true);
    expect(privy?.connectionCounts.active).toBe(1);
    // Signing never resolves through a connection today, so calling one the
    // effective target would report a migration that has not happened.
    expect(privy?.effectiveTargetType).toBe("config");
  });

  it("does not call a connection the signing target while nothing signs through it", async () => {
    await seedCredential();
    await seedConnection("ccon_setup_status_only", "active");

    const privy = statusFor(await fetchSetupStatus(), "privy");
    expect(privy?.connectionCounts.active).toBe(1);
    expect(privy?.hasLegacyConfig).toBe(false);
    expect(privy?.effectiveTargetType).toBe("none");
  });

  it("counts an inherited organization config as installed for a project", async () => {
    // Signing falls back to the organization scope when a project has no config
    // of its own, so the project is installed even though it owns no row.
    await getDb(env)
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, encryption_version, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "cust_cfg_setup_status_org_scope",
        TEST_ORG.id,
        null,
        "privy",
        "test-config",
        "sdp-custody-encryption-v1",
        "active"
      )
      .run();

    const privy = statusFor(await fetchSetupStatus(), "privy");
    expect(privy?.hasLegacyConfig).toBe(true);
    expect(privy?.effectiveTargetType).toBe("config");
  });

  it("does not count another project's config as inherited", async () => {
    await getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "prj_setup_status_sibling",
        TEST_ORG.id,
        "Sibling",
        "sibling-setup-status",
        "sandbox",
        "active",
        TEST_USER.id
      )
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, encryption_version, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "cust_cfg_setup_status_sibling",
        TEST_ORG.id,
        "prj_setup_status_sibling",
        "privy",
        "test-config",
        "sdp-custody-encryption-v1",
        "active"
      )
      .run();

    const privy = statusFor(await fetchSetupStatus(), "privy");
    expect(privy?.hasLegacyConfig).toBe(false);
    expect(privy?.effectiveTargetType).toBe("none");
  });

  it("creates nothing while reading", async () => {
    const countRows = async (table: string) => {
      const row = await getDb(env).queryOne<{ total: number | string }>(
        `SELECT COUNT(*) AS total FROM ${table} WHERE organization_id = ?`,
        [TEST_ORG.id]
      );
      return Number(row?.total ?? 0);
    };
    // custody_wallets carries no organization_id; it is scoped through its config.
    const countWallets = async () => {
      const row = await getDb(env).queryOne<{ total: number | string }>(
        `SELECT COUNT(*) AS total
           FROM custody_wallets w
           JOIN custody_configs c ON c.id = w.custody_config_id
          WHERE c.organization_id = ?`,
        [TEST_ORG.id]
      );
      return Number(row?.total ?? 0);
    };

    const before = {
      configs: await countRows("custody_configs"),
      credentials: await countRows("provider_credentials"),
      connections: await countRows("custody_connections"),
      wallets: await countWallets(),
    };

    await fetchSetupStatus();
    await fetchSetupStatus();

    expect({
      configs: await countRows("custody_configs"),
      credentials: await countRows("provider_credentials"),
      connections: await countRows("custody_connections"),
      wallets: await countWallets(),
    }).toEqual(before);
  });

  it("does not leak another organization's setup", async () => {
    await getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind("org_setup_status_other", "Other", "other-setup-status", "standard", "active")
      .run();
    await getDb(env)
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, encryption_version, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "cust_cfg_setup_status_other",
        "org_setup_status_other",
        null,
        "privy",
        "test-config",
        "sdp-custody-encryption-v1",
        "active"
      )
      .run();

    const privy = statusFor(await fetchSetupStatus(), "privy");
    expect(privy?.hasLegacyConfig).toBe(false);
  });
});
