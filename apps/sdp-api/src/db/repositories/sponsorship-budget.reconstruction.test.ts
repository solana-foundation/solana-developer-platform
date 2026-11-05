/**
 * Rebuilding a lost Redis budget window from Postgres, under the requesting
 * tenant's database identity. The `global` counter is network-wide, so its
 * rebuild must count every organization's spend even though row-level
 * security limits the request to its own rows.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { runWithTenantDatabaseIdentity } from "@/db/identity";
import { closeAllRedisClients } from "@/runtime/kv-redis";
import { SponsorshipBudgetRedis } from "@/runtime/sponsorship-budget-redis";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { flushWorkerRedis } from "@/test/mocks/kv";
import {
  type CreateSponsorshipReservationInput,
  type SponsorshipBudgetPolicy,
  SponsorshipBudgetRepository,
} from "./sponsorship-budget.repository";

const ORG_A = "org_budget_rebuild_a";
const ORG_B = "org_budget_rebuild_b";
const PROJECT_A = "prj_budget_rebuild_a";
const PROJECT_B = "prj_budget_rebuild_b";
const USER_ID = "usr_budget_rebuild";
const HOUR_BUCKET = "2026-08-03T10:00:00.000Z";
const DAY_BUCKET = "2026-08-03T00:00:00.000Z";

function reservation(
  id: string,
  organizationId: string,
  projectId: string,
  reservedLamports: number
): CreateSponsorshipReservationInput {
  return {
    id,
    network: "devnet",
    productEnvironment: "sandbox",
    organizationId,
    projectId,
    actorType: "api_key",
    actorId: "key_budget_rebuild",
    transactionDigest: `digest_${id}`,
    feePayer: "fee_payer_budget_rebuild",
    providerConfigFingerprint: "config_budget_rebuild",
    recentBlockhash: "blockhash_budget_rebuild",
    lastValidBlockHeight: 1_000n,
    reservedLamports,
    hourBucket: HOUR_BUCKET,
    dayBucket: DAY_BUCKET,
    policyVersions: { global: 1 },
  };
}

function policy(
  scopeType: SponsorshipBudgetPolicy["scopeType"],
  limit: number
): SponsorshipBudgetPolicy {
  return {
    id: `policy_budget_rebuild_${scopeType}`,
    network: "devnet",
    scopeType,
    scopeId: null,
    enabled: true,
    perTransactionLamports: 100,
    hourlyLamports: limit,
    dailyLamports: limit,
    version: 1,
    updatedBy: "test",
    updateReason: "test",
    updatedAt: new Date(0).toISOString(),
  };
}

describe("sponsorship budget window reconstruction", () => {
  const repository = new SponsorshipBudgetRepository(getDb(env));
  const budget = new SponsorshipBudgetRedis(env);

  beforeEach(async () => {
    const db = getDb(env);
    await db.execute("TRUNCATE sponsorship_budget_reservations");
    for (const [organizationId, slug] of [
      [ORG_A, "budget-rebuild-a"],
      [ORG_B, "budget-rebuild-b"],
    ] as const) {
      await db.execute(
        "INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING",
        [organizationId, organizationId, slug]
      );
    }
    await db.execute(
      "INSERT INTO users (id, email) VALUES (?, 'budget-rebuild@example.test') ON CONFLICT (id) DO NOTHING",
      [USER_ID]
    );
    await seedDefaultProjects(db, {
      organizationId: ORG_A,
      createdBy: USER_ID,
      members: [],
      ids: { sandbox: PROJECT_A, production: `${PROJECT_A}_production` },
    });
    await seedDefaultProjects(db, {
      organizationId: ORG_B,
      createdBy: USER_ID,
      members: [],
      ids: { sandbox: PROJECT_B, production: `${PROJECT_B}_production` },
    });

    // Org A has 5 lamports in flight; org B has 10 settled and 3 in flight.
    await repository.createReservation(reservation("rsv_rebuild_a_live", ORG_A, PROJECT_A, 5));
    const settled = reservation("rsv_rebuild_b_settled", ORG_B, PROJECT_B, 12);
    await repository.createReservation(settled);
    await repository.markSubmitted(settled.id, 1, "signature_rebuild_b_settled");
    await repository.settleReservation(settled.id, 1, "committed", 10);
    await repository.createReservation(reservation("rsv_rebuild_b_live", ORG_B, PROJECT_B, 3));

    await flushWorkerRedis(env);
  });

  afterAll(async () => {
    await closeAllRedisClients();
  });

  const admissionFromOrgA = (reservationId: string) =>
    runWithTenantDatabaseIdentity({ organizationId: ORG_A }, () =>
      repository.loadWindowAdmissionSnapshot({
        network: "devnet",
        organizationId: ORG_A,
        projectId: PROJECT_A,
        hourBucket: HOUR_BUCKET,
        dayBucket: DAY_BUCKET,
        excludeReservationId: reservationId,
      })
    );

  it("counts every organization's spend in global while org and project stay the caller's", async () => {
    const snapshot = await admissionFromOrgA("rsv_rebuild_a_next");

    expect(snapshot.usage).toEqual({
      hour: { global: 18, organization: 5, project: 5 },
      day: { global: 18, organization: 5, project: 5 },
    });
    expect(snapshot.liveReservations.hour.map((entry) => entry.id).sort()).toEqual([
      "rsv_rebuild_a_live",
      "rsv_rebuild_b_live",
    ]);
  });

  it("refuses a tenant caller asking for another organization's window", async () => {
    await expect(
      runWithTenantDatabaseIdentity({ organizationId: ORG_A }, () =>
        repository.loadWindowAdmissionSnapshot({
          network: "devnet",
          organizationId: ORG_B,
          projectId: PROJECT_B,
          hourBucket: HOUR_BUCKET,
          dayBucket: DAY_BUCKET,
        })
      )
    ).rejects.toThrow("caller's own organization");
  });

  it("rebuilds a flushed global counter as A + B, so org A cannot spend B's share", async () => {
    const reservationId = "rsv_rebuild_a_next";
    const snapshot = await admissionFromOrgA(reservationId);

    // Global is 18 of 20, so 3 more lamports from A overflow it; A's own
    // scopes (5 of 100) would admit them.
    await expect(
      budget.reserve({
        network: "devnet",
        organizationId: ORG_A,
        projectId: PROJECT_A,
        hourBucket: HOUR_BUCKET,
        dayBucket: DAY_BUCKET,
        reservationId,
        attempt: 1,
        amount: 3,
        policies: [policy("global", 20), policy("organization", 100), policy("project", 100)],
        ...snapshot,
      })
    ).resolves.toBe("denied");
  });
});
