import type { PolicyRule } from "@sdp/types";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { TEST_SOLANA_ADDRESSES } from "@/test/fixtures/tokens";
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
      destinationAllowlist: string[];
      maxTransferAmount?: string;
      maxDailyAmount?: string;
      defaultAction?: string;
      rules?: PolicyRule[];
      policyVersionId?: string;
      controlProfile?: {
        id: string;
        revisionId: string | null;
        revisionNumber: number | null;
      };
    };
  };
  error?: { code: string; message: string };
}

const SEED_RULES: PolicyRule[] = [
  { id: "deny-raw-signing", kind: "operation_family", family: "raw_sign", action: "deny" },
];

const PATCHED_RULES: PolicyRule[] = [
  { id: "deny-programs", kind: "operation_family", family: "program", action: "deny" },
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

/** Allowlist, both limits, and an active deny-default profile — via the endpoint itself. */
async function seedRestrictivePolicy(): Promise<WalletPolicyBody["data"]["policy"]> {
  const res = await putPolicy({
    destinationAllowlist: [TEST_SOLANA_ADDRESSES.wallet2],
    maxTransferAmount: "5",
    maxDailyAmount: "50",
    defaultAction: "deny",
    rules: SEED_RULES,
  });
  expect(res.status).toBe(200);
  const policy = ((await res.json()) as WalletPolicyBody).data.policy;
  expect(policy.defaultAction).toBe("deny");
  expect(policy.controlProfile?.revisionNumber).toBe(1);
  expect(policy.policyVersionId).toMatch(/^pwv_/);
  return policy;
}

async function countProfileRevisions(): Promise<number> {
  const row = await getDb(env)
    .prepare("SELECT COUNT(*) AS count FROM wallet_control_profile_revisions")
    .first<{ count: number | string }>();
  return Number(row?.count ?? 0);
}

describe("Payments routes — wallet policy partial updates", () => {
  installPaymentsRouteTestHooks();

  beforeEach(async () => {
    // The write-scope tenant check needs the config scoped to the key's project.
    await getDb(env)
      .prepare("UPDATE custody_configs SET project_id = ? WHERE id = ?")
      .bind(TEST_PROJECT.id, TEST_CONFIG_ID)
      .run();
  });

  it("preserves the deny default action and limits when patching rules only", async () => {
    await seedRestrictivePolicy();

    const res = await putPolicy({ rules: PATCHED_RULES });

    expect(res.status).toBe(200);
    const policy = ((await res.json()) as WalletPolicyBody).data.policy;
    expect(policy.rules).toEqual(PATCHED_RULES);
    expect(policy.defaultAction).toBe("deny");
    expect(policy.destinationAllowlist).toEqual([TEST_SOLANA_ADDRESSES.wallet2]);
    expect(policy.maxTransferAmount).toBe("5");
    expect(policy.maxDailyAmount).toBe("50");
    expect(policy.controlProfile?.revisionNumber).toBe(2);
  });

  it("preserves rules when patching the default action only", async () => {
    await seedRestrictivePolicy();

    const res = await putPolicy({ defaultAction: "approval_required" });

    expect(res.status).toBe(200);
    const policy = ((await res.json()) as WalletPolicyBody).data.policy;
    expect(policy.defaultAction).toBe("approval_required");
    expect(policy.rules).toEqual(SEED_RULES);
    expect(policy.maxTransferAmount).toBe("5");
    expect(policy.controlProfile?.revisionNumber).toBe(2);
  });

  it("preserves the control profile and limits when patching the allowlist only", async () => {
    await seedRestrictivePolicy();

    const res = await putPolicy({ destinationAllowlist: [TEST_SOLANA_ADDRESSES.wallet3] });

    expect(res.status).toBe(200);
    const policy = ((await res.json()) as WalletPolicyBody).data.policy;
    expect(policy.destinationAllowlist).toEqual([TEST_SOLANA_ADDRESSES.wallet3]);
    expect(policy.maxTransferAmount).toBe("5");
    expect(policy.maxDailyAmount).toBe("50");
    expect(policy.defaultAction).toBe("deny");
    expect(policy.rules).toEqual(SEED_RULES);
    expect(policy.controlProfile?.revisionNumber).toBe(1);
    expect(await countProfileRevisions()).toBe(1);
  });

  it("patches one limit without touching the other controls", async () => {
    await seedRestrictivePolicy();

    const res = await putPolicy({ maxTransferAmount: "9" });

    expect(res.status).toBe(200);
    const policy = ((await res.json()) as WalletPolicyBody).data.policy;
    expect(policy.maxTransferAmount).toBe("9");
    expect(policy.maxDailyAmount).toBe("50");
    expect(policy.destinationAllowlist).toEqual([TEST_SOLANA_ADDRESSES.wallet2]);
    expect(policy.defaultAction).toBe("deny");
    expect(await countProfileRevisions()).toBe(1);
  });

  it("clears a limit only with an explicit null", async () => {
    await seedRestrictivePolicy();

    const res = await putPolicy({ maxDailyAmount: null });

    expect(res.status).toBe(200);
    const policy = ((await res.json()) as WalletPolicyBody).data.policy;
    expect(policy.maxDailyAmount).toBeUndefined();
    expect(policy.maxTransferAmount).toBe("5");
    expect(policy.defaultAction).toBe("deny");
    expect(policy.rules).toEqual(SEED_RULES);
  });

  it("treats an empty patch as a no-op", async () => {
    await seedRestrictivePolicy();

    const res = await putPolicy({});

    expect(res.status).toBe(200);
    const policy = ((await res.json()) as WalletPolicyBody).data.policy;
    expect(policy.destinationAllowlist).toEqual([TEST_SOLANA_ADDRESSES.wallet2]);
    expect(policy.maxTransferAmount).toBe("5");
    expect(policy.maxDailyAmount).toBe("50");
    expect(policy.defaultAction).toBe("deny");
    expect(policy.rules).toEqual(SEED_RULES);
    expect(policy.controlProfile?.revisionNumber).toBe(1);
    expect(await countProfileRevisions()).toBe(1);
  });

  it("clears rules with an explicit empty array while preserving the default action", async () => {
    await seedRestrictivePolicy();

    const res = await putPolicy({ rules: [] });

    expect(res.status).toBe(200);
    const policy = ((await res.json()) as WalletPolicyBody).data.policy;
    expect(policy.rules).toEqual([]);
    expect(policy.defaultAction).toBe("deny");
    expect(policy.controlProfile?.revisionNumber).toBe(2);
  });

  it("rejects null for non-clearable fields", async () => {
    await seedRestrictivePolicy();

    for (const body of [{ rules: null }, { defaultAction: null }, { destinationAllowlist: null }]) {
      const res = await putPolicy(body);
      expect(res.status).toBe(400);
    }
  });

  it("applies the update when expectedPolicyVersionId matches the current version", async () => {
    const seeded = await seedRestrictivePolicy();

    const res = await putPolicy({
      maxTransferAmount: "9",
      expectedPolicyVersionId: seeded.policyVersionId,
    });

    expect(res.status).toBe(200);
    const policy = ((await res.json()) as WalletPolicyBody).data.policy;
    expect(policy.maxTransferAmount).toBe("9");
    expect(policy.controlProfile?.revisionNumber).toBe(1);
    expect(policy.policyVersionId).not.toBe(seeded.policyVersionId);
  });

  it("rejects a stale expectedPolicyVersionId with 409 and changes nothing", async () => {
    const seeded = await seedRestrictivePolicy();
    const staleVersionId = seeded.policyVersionId;

    const advance = await putPolicy({ rules: PATCHED_RULES });
    expect(advance.status).toBe(200);

    const res = await putPolicy({
      defaultAction: "allow",
      maxTransferAmount: null,
      expectedPolicyVersionId: staleVersionId,
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as WalletPolicyBody;
    expect(body.error?.code).toBe("CONFLICT");

    const policy = await getPolicy();
    expect(policy.defaultAction).toBe("deny");
    expect(policy.maxTransferAmount).toBe("5");
    expect(policy.rules).toEqual(PATCHED_RULES);
    expect(policy.controlProfile?.revisionNumber).toBe(2);
  });

  it("rejects a stale full-policy save after a limits-only update", async () => {
    // Limits-only updates advance no revision but must still invalidate stale saves.
    const seeded = await seedRestrictivePolicy();

    const tighten = await putPolicy({ maxTransferAmount: "2" });
    expect(tighten.status).toBe(200);
    const tightened = ((await tighten.json()) as WalletPolicyBody).data.policy;
    expect(tightened.controlProfile?.revisionNumber).toBe(1);
    expect(tightened.policyVersionId).not.toBe(seeded.policyVersionId);

    const staleFullSave = await putPolicy({
      destinationAllowlist: [TEST_SOLANA_ADDRESSES.wallet2],
      maxTransferAmount: "5",
      maxDailyAmount: "50",
      defaultAction: "deny",
      rules: SEED_RULES,
      expectedPolicyVersionId: seeded.policyVersionId,
    });

    expect(staleFullSave.status).toBe(409);
    const policy = await getPolicy();
    expect(policy.maxTransferAmount).toBe("2");
  });

  it("rejects expectedPolicyVersionId null when the policy has a version", async () => {
    await seedRestrictivePolicy();

    const res = await putPolicy({ maxTransferAmount: "9", expectedPolicyVersionId: null });

    expect(res.status).toBe(409);
    const policy = await getPolicy();
    expect(policy.maxTransferAmount).toBe("5");
  });

  it("accepts expectedPolicyVersionId null when the policy has never been written", async () => {
    const res = await putPolicy({
      defaultAction: "deny",
      expectedPolicyVersionId: null,
    });

    expect(res.status).toBe(200);
    const policy = ((await res.json()) as WalletPolicyBody).data.policy;
    expect(policy.defaultAction).toBe("deny");
    expect(policy.controlProfile?.revisionNumber).toBe(1);
    expect(policy.policyVersionId).toMatch(/^pwv_/);
  });

  it("rejects expectedPolicyVersionId with 409 when the policy has never been written", async () => {
    const res = await putPolicy({
      maxTransferAmount: "9",
      expectedPolicyVersionId: "pwv_never_existed",
    });

    expect(res.status).toBe(409);
    const policy = await getPolicy();
    expect(policy.maxTransferAmount).toBeUndefined();
  });

  it("keeps both changes when disjoint partial updates run concurrently", async () => {
    await seedRestrictivePolicy();

    const [limitRes, rulesRes] = await Promise.all([
      putPolicy({ maxTransferAmount: "7" }),
      putPolicy({ rules: PATCHED_RULES }),
    ]);

    expect(limitRes.status).toBe(200);
    expect(rulesRes.status).toBe(200);

    const policy = await getPolicy();
    expect(policy.maxTransferAmount).toBe("7");
    expect(policy.maxDailyAmount).toBe("50");
    expect(policy.destinationAllowlist).toEqual([TEST_SOLANA_ADDRESSES.wallet2]);
    expect(policy.rules).toEqual(PATCHED_RULES);
    expect(policy.defaultAction).toBe("deny");
  });

  it("serializes concurrent revision-creating updates without weakening controls", async () => {
    await seedRestrictivePolicy();

    const [firstRes, secondRes] = await Promise.all([
      putPolicy({ rules: PATCHED_RULES }),
      putPolicy({ defaultAction: "approval_required" }),
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

    const policy = await getPolicy();
    // Either order converges: seeded controls only explicitly replaced, never reset.
    expect(policy.controlProfile?.revisionNumber).toBe(3);
    expect(await countProfileRevisions()).toBe(3);
    expect(policy.maxTransferAmount).toBe("5");
    expect(policy.maxDailyAmount).toBe("50");
    expect(policy.defaultAction).toBe("approval_required");
    expect(policy.rules).toEqual(PATCHED_RULES);
  });
});
