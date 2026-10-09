import type { PolicyRule } from "@sdp/types";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { upsertApiKeyWalletBinding } from "@/services/api-key-wallets.service";
import { env } from "@/test/helpers/env";
import {
  installPaymentsRouteTestHooks,
  seedCachedKey,
  TEST_API_KEY,
  TEST_CONFIG_ID,
  TEST_CUSTODY_WALLET_ID,
  TEST_PROJECT,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";
import { clearKVStores } from "@/test/mocks/kv";

interface WalletPolicyBody {
  data: {
    policy: {
      defaultAction: string;
      rules: PolicyRule[];
      controlProfile: {
        id: string;
        revisionId: string | null;
        revisionNumber: number | null;
      } | null;
    };
  };
  error?: { code: string; message: string };
}

const SEED_RULES: PolicyRule[] = [
  { id: "deny-issuance", kind: "operation_family", family: "issuance", action: "deny" },
];

const PATCHED_RULES: PolicyRule[] = [
  { id: "deny-ramp", kind: "operation_family", family: "ramp", action: "deny" },
];

async function putPolicy(
  body: Record<string, unknown>,
  walletId = TEST_WALLET_ID
): Promise<Response> {
  return app.request(
    `/v1/payments/wallets/${walletId}/policies`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
      },
      body: JSON.stringify(body),
    },
    env
  );
}

async function getPolicy(walletId = TEST_WALLET_ID): Promise<WalletPolicyBody["data"]["policy"]> {
  const res = await app.request(
    `/v1/payments/wallets/${walletId}/policies`,
    { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
    env
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as WalletPolicyBody).data.policy;
}

async function seedOrganizationWalletWithSharedReference(): Promise<string> {
  const walletId = "cwlt_policy_shared_org";
  const configId = "cfg_policy_shared_org";
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO custody_configs
         (id, organization_id, project_id, provider, config_encrypted,
          encryption_version, default_wallet_id, status)
       SELECT ?, organization_id, NULL, provider, config_encrypted,
              encryption_version, default_wallet_id, 'active'
       FROM custody_configs WHERE id = ?`
      )
      .bind(configId, TEST_CONFIG_ID),
    db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
       SELECT ?, ?, wallet_id, public_key, 'active'
       FROM custody_wallets WHERE id = ?`
      )
      .bind(walletId, configId, TEST_CUSTODY_WALLET_ID),
  ]);
  return walletId;
}

/** An active deny-default profile, established through the endpoint itself. */
async function seedRestrictivePolicy(): Promise<WalletPolicyBody["data"]["policy"]> {
  const res = await putPolicy({ defaultAction: "deny", rules: SEED_RULES });
  expect(res.status).toBe(200);
  const policy = ((await res.json()) as WalletPolicyBody).data.policy;
  expect(policy.defaultAction).toBe("deny");
  expect(policy.controlProfile?.revisionNumber).toBe(1);
  return policy;
}

async function countProfiles(): Promise<number> {
  const row = await getDb(env)
    .prepare("SELECT COUNT(*) AS count FROM wallet_control_profiles")
    .first<{ count: number | string }>();
  return Number(row?.count ?? 0);
}

async function countProfileRevisions(): Promise<number> {
  const row = await getDb(env)
    .prepare("SELECT COUNT(*) AS count FROM wallet_control_profile_revisions")
    .first<{ count: number | string }>();
  return Number(row?.count ?? 0);
}

describe("Payments routes — wallet policy concurrent updates", () => {
  installPaymentsRouteTestHooks();

  beforeEach(async () => {
    // The write-scope tenant check needs the config scoped to the key's project.
    await getDb(env)
      .prepare("UPDATE custody_configs SET project_id = ? WHERE id = ?")
      .bind(TEST_PROJECT.id, TEST_CONFIG_ID)
      .run();
  });

  it("reads the exact SDP wallet while retaining its legacy response identity", async () => {
    const res = await app.request(
      `/v1/payments/wallets/${TEST_CUSTODY_WALLET_ID}/policies`,
      { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      data: {
        policy: {
          custodyWalletId: TEST_CUSTODY_WALLET_ID,
          walletId: TEST_WALLET_ID,
          defaultAction: "allow",
          rules: [],
          controlProfile: null,
        },
      },
    });
  });

  it.each([TEST_CUSTODY_WALLET_ID, TEST_WALLET_ID])(
    "returns additive balance identity for wallet selector %s",
    async (walletId) => {
      const res = await app.request(
        `/v1/payments/wallets/${walletId}/balances`,
        { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
        env
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        data: {
          walletBalances: {
            custodyWalletId: TEST_CUSTODY_WALLET_ID,
            walletId: TEST_WALLET_ID,
            balances: expect.arrayContaining([
              expect.objectContaining({ token: "SOL", amount: "4200000000", uiAmount: "4.2" }),
            ]),
          },
        },
      });
    }
  );

  it("refuses a selected grant whose provider reference collides with another SDP wallet ID", async () => {
    const otherWalletId = "cwlt_policy_namespace_collision";
    await getDb(env)
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         SELECT ?, custody_config_id, ?, public_key, 'active'
         FROM custody_wallets WHERE id = ?`
      )
      .bind(otherWalletId, TEST_CUSTODY_WALLET_ID, TEST_CUSTODY_WALLET_ID)
      .run();
    await seedCachedKey({
      walletScope: "selected",
      signingWalletId: TEST_CUSTODY_WALLET_ID,
      walletBindings: [
        {
          walletId: TEST_CUSTODY_WALLET_ID,
          custodyWalletId: otherWalletId,
          permissions: ["wallets:read"],
        },
      ],
    });

    const res = await app.request(
      `/v1/payments/wallets/${TEST_CUSTODY_WALLET_ID}/policies`,
      { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );

    expect(res.status).toBe(409);
    expect(await res.json()).not.toHaveProperty("data.policy");
  });

  it("keeps policies and revisions on exact project and organization wallets with shared references", async () => {
    const otherWalletId = await seedOrganizationWalletWithSharedReference();
    const written = await putPolicy(
      { defaultAction: "deny", rules: SEED_RULES, expectedRevisionId: null },
      TEST_CUSTODY_WALLET_ID
    );
    expect(written.status).toBe(200);
    const policy = ((await written.json()) as WalletPolicyBody).data.policy;
    expect(await getPolicy(TEST_CUSTODY_WALLET_ID)).toMatchObject({
      defaultAction: "deny",
      rules: SEED_RULES,
      controlProfile: { id: policy.controlProfile?.id },
    });
    expect(await getPolicy(otherWalletId)).toMatchObject({
      defaultAction: "allow",
      rules: [],
      controlProfile: null,
    });
    const revisions = await app.request(
      `/v1/payments/wallets/${TEST_CUSTODY_WALLET_ID}/policies/revisions`,
      { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );
    expect(revisions.status).toBe(200);
    expect(await revisions.json()).toMatchObject({
      data: {
        profile: { custodyWalletId: TEST_CUSTODY_WALLET_ID },
        revisions: [expect.objectContaining({ rules: SEED_RULES })],
      },
    });
    const ambiguous = await app.request(
      `/v1/payments/wallets/${TEST_WALLET_ID}/policies`,
      { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );
    expect(ambiguous.status).toBe(409);
  });

  it("does not substitute an active alias when the exact wallet becomes inactive", async () => {
    const otherWalletId = await seedOrganizationWalletWithSharedReference();
    await getDb(env)
      .prepare("UPDATE custody_wallets SET status = 'inactive' WHERE id = ?")
      .bind(TEST_CUSTODY_WALLET_ID)
      .run();

    const read = await app.request(
      `/v1/payments/wallets/${TEST_CUSTODY_WALLET_ID}/policies`,
      { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );
    expect(read.status).toBe(404);
    expect(
      (await putPolicy({ defaultAction: "deny", rules: SEED_RULES }, TEST_CUSTODY_WALLET_ID)).status
    ).toBe(404);
    expect(await getPolicy(otherWalletId)).toMatchObject({ defaultAction: "allow", rules: [] });
  });

  it("does not reinterpret an inactive SDP wallet ID as an active provider reference", async () => {
    await getDb(env)
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         SELECT 'cwlt_policy_inactive_collision', custody_config_id, ?, public_key, 'active'
         FROM custody_wallets WHERE id = ?`
      )
      .bind(TEST_CUSTODY_WALLET_ID, TEST_CUSTODY_WALLET_ID)
      .run();
    await getDb(env)
      .prepare("UPDATE custody_wallets SET status = 'inactive' WHERE id = ?")
      .bind(TEST_CUSTODY_WALLET_ID)
      .run();

    const res = await app.request(
      `/v1/payments/wallets/${TEST_CUSTODY_WALLET_ID}/policies`,
      { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
      env
    );

    expect(res.status).toBe(404);
    expect(await res.json()).not.toHaveProperty("data.policy");
  });

  it("keeps ambiguous provider grants deny-only for exact and legacy requests", async () => {
    await upsertApiKeyWalletBinding(getDb(env), TEST_API_KEY.id, {
      walletId: TEST_WALLET_ID,
      permissions: ["wallets:read"],
    });
    await seedOrganizationWalletWithSharedReference();
    await clearKVStores(env);

    for (const walletId of [TEST_CUSTODY_WALLET_ID, TEST_WALLET_ID]) {
      const res = await app.request(
        `/v1/payments/wallets/${walletId}/policies`,
        { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
        env
      );
      expect(res.status).toBe(403);
      expect(await res.json()).not.toHaveProperty("data.policy");
    }
  });

  it("refuses policy authoring from a non-admin API key", async () => {
    await seedRestrictivePolicy();
    await seedCachedKey({
      role: "api_developer",
      permissions: ["wallets:read", "wallets:write", "payments:read", "payments:write"],
    });

    const res = await putPolicy({ defaultAction: "allow", rules: [] });

    expect(res.status).toBe(403);
    const body = (await res.json()) as WalletPolicyBody;
    expect(body.error?.message).toContain("api_admin");
    const policy = await getPolicy();
    expect(policy.defaultAction).toBe("deny");
    expect(policy.controlProfile?.revisionNumber).toBe(1);
  });

  it("keeps policy reads open to non-admin API keys", async () => {
    await seedRestrictivePolicy();
    await seedCachedKey({
      role: "api_readonly",
      permissions: ["wallets:read", "payments:read"],
    });

    const policy = await getPolicy();
    expect(policy.defaultAction).toBe("deny");
  });

  it("applies the update when expectedRevisionId matches the active revision", async () => {
    const seeded = await seedRestrictivePolicy();

    const res = await putPolicy({
      defaultAction: "approval_required",
      rules: PATCHED_RULES,
      expectedRevisionId: seeded.controlProfile?.revisionId,
    });

    expect(res.status).toBe(200);
    const policy = ((await res.json()) as WalletPolicyBody).data.policy;
    expect(policy.defaultAction).toBe("approval_required");
    expect(policy.rules).toEqual(PATCHED_RULES);
    expect(policy.controlProfile?.revisionNumber).toBe(2);
  });

  it("writes a fail-closed audit entry for every policy rewrite", async () => {
    const seeded = await seedRestrictivePolicy();

    const res = await putPolicy({
      defaultAction: "allow",
      rules: [],
      expectedRevisionId: seeded.controlProfile?.revisionId,
    });
    expect(res.status).toBe(200);
    const policy = ((await res.json()) as WalletPolicyBody).data.policy;

    const rows = await getDb(env)
      .prepare(
        `SELECT metadata FROM audit_logs
         WHERE action = 'update' AND resource_type = 'custody_wallet'
           AND metadata::jsonb ->> 'action' = 'update_wallet_policy'
         ORDER BY created_at ASC`
      )
      .all<{ metadata: string }>();
    // One entry per rewrite: the seed and the loosening update.
    expect(rows.results).toHaveLength(2);
    const loosened = JSON.parse(rows.results[1]?.metadata ?? "{}") as Record<string, unknown>;
    expect(loosened).toMatchObject({
      action: "update_wallet_policy",
      defaultAction: "allow",
      ruleCount: 0,
      revisionId: policy.controlProfile?.revisionId,
    });
  });

  it("rejects a stale expectedRevisionId with 409 and changes nothing", async () => {
    const seeded = await seedRestrictivePolicy();
    const staleRevisionId = seeded.controlProfile?.revisionId;

    const advance = await putPolicy({ defaultAction: "deny", rules: PATCHED_RULES });
    expect(advance.status).toBe(200);

    // The stale editor would otherwise restore the seeded rules and weaken nothing-in-between.
    const res = await putPolicy({
      defaultAction: "allow",
      rules: SEED_RULES,
      expectedRevisionId: staleRevisionId,
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as WalletPolicyBody;
    expect(body.error?.code).toBe("CONFLICT");

    const policy = await getPolicy();
    expect(policy.defaultAction).toBe("deny");
    expect(policy.rules).toEqual(PATCHED_RULES);
    expect(policy.controlProfile?.revisionNumber).toBe(2);
    expect(await countProfileRevisions()).toBe(2);
  });

  it("rejects expectedRevisionId null when a profile is already active", async () => {
    await seedRestrictivePolicy();

    const res = await putPolicy({
      defaultAction: "allow",
      rules: [],
      expectedRevisionId: null,
    });

    expect(res.status).toBe(409);
    const policy = await getPolicy();
    expect(policy.defaultAction).toBe("deny");
    expect(policy.rules).toEqual(SEED_RULES);
  });

  it("accepts expectedRevisionId null when no profile is active", async () => {
    const res = await putPolicy({
      defaultAction: "deny",
      rules: SEED_RULES,
      expectedRevisionId: null,
    });

    expect(res.status).toBe(200);
    const policy = ((await res.json()) as WalletPolicyBody).data.policy;
    expect(policy.defaultAction).toBe("deny");
    expect(policy.controlProfile?.revisionNumber).toBe(1);
  });

  it("rejects an unknown expectedRevisionId with 409 when no profile is active", async () => {
    const res = await putPolicy({
      defaultAction: "allow",
      rules: [],
      expectedRevisionId: "wcpr_never_existed",
    });

    expect(res.status).toBe(409);
    expect(await countProfiles()).toBe(0);
  });

  it("overwrites unconditionally when expectedRevisionId is omitted", async () => {
    await seedRestrictivePolicy();

    const res = await putPolicy({ defaultAction: "allow", rules: [] });

    expect(res.status).toBe(200);
    const policy = ((await res.json()) as WalletPolicyBody).data.policy;
    expect(policy.defaultAction).toBe("allow");
    expect(policy.controlProfile?.revisionNumber).toBe(2);
  });

  it("serializes concurrent updates into ordered revisions of one profile", async () => {
    await seedRestrictivePolicy();

    const [firstRes, secondRes] = await Promise.all([
      putPolicy({ defaultAction: "deny", rules: PATCHED_RULES }),
      putPolicy({ defaultAction: "approval_required", rules: SEED_RULES }),
    ]);

    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);

    // A post-commit summary read would let both responses echo the final revision.
    const firstPolicy = ((await firstRes.json()) as WalletPolicyBody).data.policy;
    const secondPolicy = ((await secondRes.json()) as WalletPolicyBody).data.policy;
    expect(
      new Set([
        firstPolicy.controlProfile?.revisionNumber,
        secondPolicy.controlProfile?.revisionNumber,
      ])
    ).toEqual(new Set([2, 3]));

    expect(await countProfiles()).toBe(1);
    expect(await countProfileRevisions()).toBe(3);
    expect((await getPolicy()).controlProfile?.revisionNumber).toBe(3);
  });

  it("creates a single profile when a wallet's first updates race", async () => {
    // Nothing exists to lock at this point, so the wallet row is what serializes these.
    const [firstRes, secondRes] = await Promise.all([
      putPolicy({ defaultAction: "deny", rules: SEED_RULES }),
      putPolicy({ defaultAction: "approval_required", rules: PATCHED_RULES }),
    ]);

    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);

    expect(await countProfiles()).toBe(1);
    expect(await countProfileRevisions()).toBe(2);
    expect((await getPolicy()).controlProfile?.revisionNumber).toBe(2);
  });

  it("rejects a stale save that loses a concurrently created profile", async () => {
    const concurrent = await putPolicy({ defaultAction: "deny", rules: SEED_RULES });
    expect(concurrent.status).toBe(200);

    // The editor loaded the wallet before any profile existed.
    const res = await putPolicy({
      defaultAction: "allow",
      rules: [],
      expectedRevisionId: null,
    });

    expect(res.status).toBe(409);
    const policy = await getPolicy();
    expect(policy.defaultAction).toBe("deny");
    expect(policy.rules).toEqual(SEED_RULES);
  });
});
