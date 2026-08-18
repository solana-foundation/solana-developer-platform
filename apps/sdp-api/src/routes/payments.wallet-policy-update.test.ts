import type { PolicyRule } from "@sdp/types";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { env } from "@/test/helpers/env";
import {
  installPaymentsRouteTestHooks,
  TEST_API_KEY,
  TEST_CONFIG_ID,
  TEST_PROJECT,
  TEST_WALLET_ID,
} from "@/test/helpers/payments-routes";

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

async function putPolicy(body: Record<string, unknown>): Promise<Response> {
  return app.request(
    `/v1/payments/wallets/${TEST_WALLET_ID}/policies`,
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

async function getPolicy(): Promise<WalletPolicyBody["data"]["policy"]> {
  const res = await app.request(
    `/v1/payments/wallets/${TEST_WALLET_ID}/policies`,
    { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
    env
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as WalletPolicyBody).data.policy;
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
