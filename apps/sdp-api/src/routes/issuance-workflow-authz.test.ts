/**
 * Workflow authorization, exercised through the real route stack.
 *
 * The unit test in handlers/workflow-authz.test.ts pins the tier decision itself. This
 * one pins the wiring: that the guard is actually reached on every write path, with the
 * tier read from the STORED action for edits and decisions. The bug it exists for is a
 * `tokens:write` member being 403'd on POST /tokens/:id/seize while authoring — and then
 * approving — a seize rule instead.
 */

import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey } from "@sdp/types";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_PROJECT } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";

const TOKEN_ID = "tok_workflow_authz_test";

// Two principals differing only in `tokens:admin` — the exact line the tier gate draws.
const MEMBER_KEY = { id: "key_wf_member", raw: "sk_test_wf_member", prefix: "sk_test_wf_" };
const ADMIN_KEY = { id: "key_wf_admin", raw: "sk_test_wf_admin", prefix: "sk_test_wf_a" };
// Read-only principal (the `api_readonly` scope set) for the holder-enrollment boundary.
const READONLY_KEY = { id: "key_wf_readonly", raw: "sk_test_wf_readonly", prefix: "sk_test_wf_r" };

function cachedKey(id: string, permissions: string[]): CachedApiKey {
  return {
    id,
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    role: "api_admin",
    permissions,
    environment: "sandbox",
    rateLimitTier: "standard",
    allowedIps: null,
    signingWalletId: null,
    status: "active",
    expiresAt: null,
    rotationDeadline: null,
  } as CachedApiKey;
}

function post(key: { raw: string }, path: string, body?: unknown) {
  return app.request(
    path,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key.raw}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env
  );
}

describe("workflow authorization (routes)", () => {
  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  beforeEach(async () => {
    const db = getDb(env);
    const kv = createKVStoreSet(env);

    // Clear rate-limit KV so repeated requests across tests don't 429.
    const rateLimitKeys = await kv.rateLimits.list();
    for (const key of rateLimitKeys.keys) {
      await kv.rateLimits.delete(key.name);
    }

    await db.prepare("DELETE FROM workflow_executions").run();
    await db.prepare("DELETE FROM asset_workflows").run();
    // One test seeds a profile to unlock a capability-gated action; every other test in
    // this file expects the bare token, so it must not survive into the next one.
    await db.prepare("DELETE FROM asset_profiles").run();
    await db.prepare("DELETE FROM issued_tokens").run();
    await db.prepare("DELETE FROM api_keys WHERE project_id IS NOT NULL").run();
    await db.prepare("DELETE FROM projects").run();

    await db
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    await db
      .prepare(
        "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
      )
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    await db
      .prepare(
        `INSERT OR REPLACE INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_PROJECT.id,
        TEST_ORG.id,
        TEST_PROJECT.name,
        TEST_PROJECT.slug,
        TEST_PROJECT.environment,
        "active",
        TEST_USER.id
      )
      .run();

    // A deployed, allowlist-enabled token so both an automated and a privileged action
    // clear the capability gate and only the tier gate can reject.
    await db
      .prepare(
        `INSERT OR REPLACE INTO issued_tokens
           (id, project_id, organization_id, created_by, mint_address, mint_authority,
            abl_list_address, name, symbol, decimals, template, is_mintable,
            allowlist_enabled, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'Authz Test', 'AUTHZ', 6, 'stablecoin', 1, 1, 'active')`
      )
      .bind(
        TOKEN_ID,
        TEST_PROJECT.id,
        TEST_ORG.id,
        TEST_USER.id,
        "So11111111111111111111111111111111111111112",
        "So11111111111111111111111111111111111111112",
        "So11111111111111111111111111111111111111112"
      )
      .run();

    for (const [key, permissions] of [
      [MEMBER_KEY, ["tokens:read", "tokens:write"]],
      [ADMIN_KEY, ["tokens:read", "tokens:write", "tokens:admin"]],
      [READONLY_KEY, ["tokens:read"]],
    ] as const) {
      const hash = await hashString(key.raw, (env as { API_KEY_PEPPER: string }).API_KEY_PEPPER);
      await db
        .prepare(
          `INSERT OR REPLACE INTO api_keys
             (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
           VALUES (?, ?, ?, ?, 'wf authz key', ?, ?, 'api_admin', ?, 'active')`
        )
        .bind(
          key.id,
          TEST_ORG.id,
          TEST_PROJECT.id,
          TEST_USER.id,
          key.prefix,
          hash,
          JSON.stringify(permissions)
        )
        .run();
      await kv.apiKeys.put(`key:${hash}`, JSON.stringify(cachedKey(key.id, [...permissions])));
    }
  });

  const base = `/v1/issuance/tokens/${TOKEN_ID}/workflows`;

  it("refuses a tokens:write principal a seize rule", async () => {
    const res = await post(MEMBER_KEY, base, {
      triggerType: "kyc_approved",
      actionType: "seize",
      actionParams: {
        source: "So11111111111111111111111111111111111111112",
        destination: "So11111111111111111111111111111111111111112",
        amount: "1000",
      },
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("INSUFFICIENT_PERMISSIONS");

    // Nothing was written — the guard runs before any persistence.
    const stored = await getDb(env)
      .prepare("SELECT COUNT(*) AS count FROM asset_workflows")
      .first<{ count: number }>();
    expect(Number(stored?.count ?? 0)).toBe(0);
  });

  it.each(["mint", "burn", "force_burn", "pause", "freeze"])(
    "refuses a tokens:write principal a %s rule",
    async (actionType) => {
      const res = await post(MEMBER_KEY, base, {
        triggerType: "kyc_approved",
        actionType,
        actionParams: actionType === "pause" || actionType === "freeze" ? {} : { amount: "1" },
      });
      expect(res.status).toBe(403);
    }
  );

  it("lets a tokens:write principal author an automated rule", async () => {
    const res = await post(MEMBER_KEY, base, {
      triggerType: "kyc_approved",
      actionType: "allowlist_add",
    });
    expect(res.status).toBe(201);
  });

  // `mint`, not `seize`: seize additionally needs the permanentDelegate capability, which
  // this token doesn't have, and a 400 from that gate would say nothing about the tier.
  // (That the member's seize above is 403 rather than 400 is itself the point — the tier
  // gate runs before the asset lookup, so an unauthorized caller learns nothing.)
  it("lets a tokens:admin principal author a privileged rule", async () => {
    const res = await post(ADMIN_KEY, base, {
      triggerType: "kyc_approved",
      actionType: "mint",
      actionParams: { amount: "1000" },
    });
    expect(res.status).toBe(201);
  });

  // `requires_approval` means the action is irreversible, so "held for a human" is a
  // property of the tier, not a default a caller may override. The engine already forces
  // awaiting_review for the tier, so accepting `auto` was never an approval bypass — it
  // persisted a row that contradicted the engine, and the builder renders review_mode, so
  // a destructive rule was displayed to operators as auto-apply.
  describe("review mode for irreversible actions", () => {
    async function storedReviewMode(workflowId: string) {
      const row = await getDb(env)
        .prepare("SELECT review_mode FROM asset_workflows WHERE id = ?")
        .bind(workflowId)
        .first<{ review_mode: string }>();
      return row?.review_mode;
    }

    it("refuses an explicit auto on create, writing nothing", async () => {
      const res = await post(ADMIN_KEY, base, {
        triggerType: "kyc_approved",
        actionType: "mint",
        actionParams: { amount: "1000" },
        reviewMode: "auto",
      });

      expect(res.status).toBe(400);
      const stored = await getDb(env)
        .prepare("SELECT COUNT(*) AS count FROM asset_workflows")
        .first<{ count: number }>();
      expect(Number(stored?.count ?? 0)).toBe(0);
    });

    it("refuses flipping a stored mint rule to auto through an edit", async () => {
      const created = await post(ADMIN_KEY, base, {
        triggerType: "kyc_approved",
        actionType: "mint",
        actionParams: { amount: "1000" },
      });
      expect(created.status).toBe(201);
      const { data } = (await created.json()) as { data: { workflow: { id: string } } };
      expect(await storedReviewMode(data.workflow.id)).toBe("manual");

      const patched = await app.request(
        `${base}/${data.workflow.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${ADMIN_KEY.raw}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ reviewMode: "auto" }),
        },
        env
      );

      expect(patched.status).toBe(400);
      expect(await storedReviewMode(data.workflow.id)).toBe("manual");
    });

    // The builder locks its review selector to manual for this tier but keeps its own
    // state behind it, so it has to send the locked value rather than the raw state.
    // This is the payload it sends — a rejection here means destructive rules cannot be
    // authored from the UI at all.
    it("accepts the manual the builder sends for a locked action", async () => {
      const res = await post(ADMIN_KEY, base, {
        triggerType: "kyc_approved",
        actionType: "mint",
        actionParams: { amount: "1000" },
        reviewMode: "manual",
      });

      expect(res.status).toBe(201);
      const { data } = (await res.json()) as { data: { workflow: { id: string } } };
      expect(await storedReviewMode(data.workflow.id)).toBe("manual");
    });

    // The rejection is scoped to the tier that forbids auto: `sensitive` genuinely lets
    // an issuer opt into unattended runs. `freeze` is capability-gated, so this needs the
    // asset profile that unlocks it.
    it("still lets a sensitive action opt into auto", async () => {
      await getDb(env)
        .prepare(
          `INSERT OR REPLACE INTO asset_profiles
             (id, organization_id, project_id, token_id, issuance_metadata, status)
           VALUES (?, ?, ?, ?, ?::jsonb, 'active')`
        )
        .bind(
          "asset_profile_wf_authz",
          TEST_ORG.id,
          TEST_PROJECT.id,
          TOKEN_ID,
          JSON.stringify({ settings: { selected: { freezeAccounts: { enabled: true } } } })
        )
        .run();

      const res = await post(ADMIN_KEY, base, {
        triggerType: "kyc_rejected",
        actionType: "freeze",
        reviewMode: "auto",
      });

      expect(res.status).toBe(201);
      const { data } = (await res.json()) as { data: { workflow: { id: string } } };
      expect(await storedReviewMode(data.workflow.id)).toBe("auto");
    });
  });

  // The escalation this closes has a second door: edit or delete a rule an admin wrote.
  // The tier must come from the stored action, since the body can't change action_type.
  it("refuses a tokens:write principal an edit or delete of a privileged rule", async () => {
    const created = await post(ADMIN_KEY, base, {
      triggerType: "kyc_approved",
      actionType: "mint",
      actionParams: { amount: "1" },
    });
    const { data } = (await created.json()) as { data: { workflow: { id: string } } };
    const rulePath = `${base}/${data.workflow.id}`;

    const patched = await app.request(
      rulePath,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${MEMBER_KEY.raw}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ actionParams: { amount: "999999" } }),
      },
      env
    );
    expect(patched.status).toBe(403);

    const deleted = await app.request(
      rulePath,
      { method: "DELETE", headers: { Authorization: `Bearer ${MEMBER_KEY.raw}` } },
      env
    );
    expect(deleted.status).toBe(403);
  });

  // And a third: approve a held execution someone else's rule enqueued.
  it("refuses a tokens:write principal the approval of a held mint", async () => {
    const created = await post(ADMIN_KEY, base, {
      triggerType: "kyc_approved",
      actionType: "mint",
      actionParams: { amount: "1" },
    });
    const { data } = (await created.json()) as { data: { workflow: { id: string } } };

    const executionId = "workflow_execution_authz_test";
    await getDb(env)
      .prepare(
        `INSERT INTO workflow_executions
           (id, organization_id, project_id, workflow_id, token_id, trigger_type, action_type,
            status, idempotency_key, trigger_payload, max_attempts)
         VALUES (?, ?, ?, ?, ?, 'kyc_approved', 'mint', 'awaiting_review', ?, '{}'::jsonb, 5)`
      )
      .bind(
        executionId,
        TEST_ORG.id,
        TEST_PROJECT.id,
        data.workflow.id,
        TOKEN_ID,
        `authz:${executionId}`
      )
      .run();

    const path = `${base}/executions/${executionId}`;
    expect((await post(MEMBER_KEY, `${path}/approve`)).status).toBe(403);
    expect((await post(MEMBER_KEY, `${path}/reject`)).status).toBe(403);

    // Still held — a refused decision must not move the execution.
    const row = await getDb(env)
      .prepare("SELECT status FROM workflow_executions WHERE id = ?")
      .bind(executionId)
      .first<{ status: string }>();
    expect(row?.status).toBe("awaiting_review");

    // The admin can, and the decision is attributed.
    expect((await post(ADMIN_KEY, `${path}/approve`)).status).toBe(200);
    const decided = await getDb(env)
      .prepare("SELECT status, decided_by FROM workflow_executions WHERE id = ?")
      .bind(executionId)
      .first<{ status: string; decided_by: string | null }>();
    expect(decided?.status).toBe("pending");
    expect(decided?.decided_by).toBe(ADMIN_KEY.id);
  });

  // Holder enrollment is a write: it creates kyc_wallets/wallet_asset_enrollments rows and
  // can complete clearance, which emits kyc_approved and drives automated rules. The
  // permission is declared on the route (`requirePermissions("tokens:write")`), not in the
  // handler, so these pin the boundary at the HTTP layer where it is actually enforced.
  describe("holder enrollment", () => {
    const holders = `/v1/issuance/tokens/${TOKEN_ID}/holders`;
    const wallet = { walletAddress: "So11111111111111111111111111111111111111112" };

    it("refuses a read-only principal", async () => {
      const res = await post(READONLY_KEY, holders, wallet);
      expect(res.status).toBe(403);

      // Nothing was written — a 403 that still enrolled would be no protection at all.
      const row = await getDb(env)
        .prepare("SELECT COUNT(*)::int AS n FROM kyc_wallets WHERE wallet_address = ?")
        .bind(wallet.walletAddress)
        .first<{ n: number }>();
      expect(row?.n).toBe(0);
    });

    // Proves the 403 above is the permission gate rather than an unreachable route (a
    // disabled feature flag or bad path would fail this too).
    it("allows a tokens:write principal", async () => {
      expect((await post(MEMBER_KEY, holders, wallet)).status).toBe(201);
    });
  });
});
