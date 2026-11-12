import assert from "node:assert/strict";
import { runInClusterScope } from "@sdp/rpc/scope";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { runWithTenantDatabaseIdentity } from "@/db/identity";
import { CustodyPolicyStore } from "@/services/stores/custody-policy.store";
import {
  seedTestPrivyConnection,
  writeTestPrivyCredentialSecret,
} from "@/test/helpers/custody-connections";
import { env as baseEnv } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { checkDueProviderPolicies } from "./provider-policy";

const env = { ...baseEnv, CUSTODY_ENCRYPTION_KEY: Buffer.alloc(32, 19).toString("base64") };
const db = () => getDb(env);
const store = () => new CustodyPolicyStore(db());
const run = () =>
  runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
    checkDueProviderPolicies(env)
  );

async function seed(name: string, environment: "sandbox" | "production" = "sandbox") {
  const organizationId = `org_${name}`;
  const projectId = `prj_${name}_${environment}`;
  const userId = `usr_${name}`;
  const connectionId = `cconn_${name}`;
  const credentialId = `pcred_${name}`;
  const walletId = `cwlt_${name}`;
  await db().execute(
    "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'enterprise', 'active')",
    [organizationId, name, name]
  );
  await db().execute(
    "INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')",
    [userId, `${name}@example.com`]
  );
  await seedDefaultProjects(db(), {
    organizationId,
    createdBy: userId,
    members: [],
    ids: { sandbox: `prj_${name}_sandbox`, production: `prj_${name}_production` },
  });
  const stored = await writeTestPrivyCredentialSecret(env, {
    organizationId,
    credentialId,
    appId: `app_${name}`,
    appSecret: "test-secret",
  });
  await db().transaction((tx) =>
    seedTestPrivyConnection(tx, {
      organizationId,
      projectId,
      connectionId,
      credentialId,
      createdBy: userId,
      stored,
      providerAccountFingerprint: `sha256:${name}`,
      lastCheckStatus: "success",
      defaultCustodyWalletId: walletId,
      wallets: [
        {
          id: walletId,
          walletId: `privy_${name}`,
          publicKey: "So11111111111111111111111111111111111111112",
          label: name,
          purpose: null,
          status: "active",
        },
      ],
    })
  );
  return { organizationId, projectId, connectionId, credentialId, walletId };
}

describe("BYOK provider policy observations", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
  });
  afterEach(() => vi.restoreAllMocks());

  it("records an absent wallet policy with its connection audit and avoids another read within the hour", async () => {
    const scope = await seed("missing");
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ id: "missing", policy_ids: [] }));
    await run();
    expect(
      await store().read(scope.organizationId, scope.projectId, { walletId: scope.walletId })
    ).toMatchObject({ status: "missing", reason: "no_policy" });
    expect(
      await store().read(scope.organizationId, scope.projectId, {
        connectionId: scope.connectionId,
      })
    ).toMatchObject({ status: "missing" });
    expect(
      await db().queryOne(
        "SELECT resource_id FROM audit_logs WHERE resource_type = 'custody_connection' AND action = 'check'"
      )
    ).toMatchObject({ resource_id: scope.connectionId });
    await run();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("isolates environments and connection reads by tenant and project", async () => {
    const own = await seed("own");
    const other = await seed("other");
    await seed("prod", "production");
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) =>
        Response.json({ id: String(url).split("/").at(-1), policy_ids: ["p"] })
      );
    await run();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      await store().read(own.organizationId, other.projectId, { walletId: other.walletId })
    ).toMatchObject({ status: "unknown", reason: "not_checked" });
    expect(
      await runWithTenantDatabaseIdentity({ organizationId: own.organizationId }, () =>
        store().read(own.organizationId, own.projectId, { walletId: other.walletId })
      )
    ).toMatchObject({ status: "unknown", reason: "not_checked" });
  });

  it("claims a wallet once across concurrent workers and rejects an older or replaced-credential observation", async () => {
    await seed("race");
    const batches = await Promise.all([
      store().claim({ environment: "sandbox" }, 25),
      store().claim({ environment: "sandbox" }, 25),
    ]);
    const targets = batches.flat();
    expect(targets).toHaveLength(1);
    const target = targets[0];
    assert(target);
    const check = {
      status: "missing" as const,
      reason: "no_policy" as const,
      checkedAt: new Date().toISOString(),
    };
    expect(
      await store().record({ ...target, provider_credential_id: "old-credential" }, check)
    ).toBe(false);
    expect(await store().record({ ...target, claim: "2000-01-01T00:00:00Z" }, check)).toBe(false);
    expect(await store().record(target, check)).toBe(true);
  });

  it("retries a lost claim and never presents a stale or replaced-credential policy as current", async () => {
    const scope = await seed("stale");
    await store().claim({ environment: "sandbox" }, 25);
    await db().execute(
      "UPDATE custody_wallets SET policy_check_claimed_at = NOW() - INTERVAL '6 minutes' WHERE id = ?",
      [scope.walletId]
    );
    const [target] = await store().claim({ environment: "sandbox" }, 25);
    assert(target);
    await store().record(target, {
      status: "present",
      reason: "policy_detected",
      checkedAt: "2000-01-01T00:00:00.000Z",
    });
    expect(
      await store().read(scope.organizationId, scope.projectId, { walletId: scope.walletId })
    ).toMatchObject({ status: "unknown", reason: "stale" });
    await db().execute(
      `UPDATE custody_wallets SET provider_policy = jsonb_set(provider_policy, '{credentialId}', '"old-credential"') WHERE id = ?`,
      [scope.walletId]
    );
    expect(
      await store().read(scope.organizationId, scope.projectId, { walletId: scope.walletId })
    ).toMatchObject({ status: "unknown", reason: "credential_changed" });
  });

  it("records a denied policy read as unknown without changing wallet or connection admission", async () => {
    const scope = await seed("denied");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("private details", { status: 403 })
    );
    await run();
    expect(
      await store().read(scope.organizationId, scope.projectId, { walletId: scope.walletId })
    ).toMatchObject({ status: "unknown", reason: "access_denied" });
    expect(
      await db().queryOne("SELECT status FROM custody_connections WHERE id = ?", [
        scope.connectionId,
      ])
    ).toEqual({ status: "active" });
    expect(
      await db().queryOne("SELECT status FROM custody_wallets WHERE id = ?", [scope.walletId])
    ).toEqual({ status: "active" });
  });

  it("rolls the observation back when its audit insert fails", async () => {
    const scope = await seed("rollback");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ id: "rollback", policy_ids: [] })
    );
    await db().execute(
      `CREATE FUNCTION test_refuse_policy_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit refused'; END $$`
    );
    await db().execute(
      `CREATE TRIGGER test_refuse_policy_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION test_refuse_policy_audit()`
    );
    try {
      await expect(run()).rejects.toThrow();
      expect(
        await db().queryOne("SELECT provider_policy FROM custody_wallets WHERE id = ?", [
          scope.walletId,
        ])
      ).toEqual({ provider_policy: null });
    } finally {
      await db().execute("DROP TRIGGER test_refuse_policy_audit ON audit_logs");
      await db().execute("DROP FUNCTION test_refuse_policy_audit()");
    }
  });
});
