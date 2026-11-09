import { runInClusterScope } from "@sdp/rpc/scope";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import {
  detectMoneyMovementAnomalies,
  MONEY_MOVEMENT_ANOMALY_FACTOR,
} from "@/services/jobs/detect-money-movement-anomalies";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

const SANDBOX_PROJECT_ID = "prj_anomaly_job_test";
const PRODUCTION_PROJECT_ID = "prj_anomaly_job_test_production";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const HOUR_MS = 60 * 60 * 1000;
/** Ten minutes into an hour, so the hour checked is [CHECKED, CHECKED + 1h). */
const NOW = new Date("2026-11-09T12:10:00.000Z");
const CHECKED = Date.parse("2026-11-09T11:00:00.000Z");

let sequence = 0;

async function seedMovement(input: {
  hoursBeforeChecked: number;
  amount: string;
  token?: string;
  type?: string;
  status?: string;
  direction?: string;
  recurring?: boolean;
  projectId?: string;
}): Promise<void> {
  sequence += 1;
  const at = new Date(CHECKED - input.hoursBeforeChecked * HOUR_MS + 60_000).toISOString();
  await getDb(env)
    .prepare(
      `INSERT INTO payment_transfers
         (id, organization_id, project_id, wallet_id, source_address, destination_address,
          token, amount, type, direction, status, provider_data, created_at, updated_at)
       VALUES (?, ?, ?, 'wallet_anomaly', 'source', 'destination', ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`
    )
    .bind(
      `xfr_anomaly_${sequence}`,
      TEST_ORG.id,
      input.projectId ?? SANDBOX_PROJECT_ID,
      input.token ?? USDC,
      input.amount,
      input.type ?? "transfer",
      input.direction ?? "outbound",
      input.status ?? "finalized",
      JSON.stringify(
        input.recurring
          ? {
              recurringPaymentId: "rp_anomaly",
              subscriptionId: "psub_anomaly",
              collectionDueAt: at,
            }
          : {}
      ),
      at,
      at
    )
    .run();
}

/** A quiet week: one movement of `amount` in each of the given past hours. */
async function seedBaseline(amount: string, hours: number[] = [5, 30, 60, 100]): Promise<void> {
  for (const hoursBeforeChecked of hours) {
    await seedMovement({ hoursBeforeChecked, amount });
  }
}

function scan(environment: "sandbox" | "production" = "sandbox") {
  return runInClusterScope(
    {
      projectId: environment === "sandbox" ? SANDBOX_PROJECT_ID : PRODUCTION_PROJECT_ID,
      environment,
    },
    () => detectMoneyMovementAnomalies(env, NOW)
  );
}

describe("detectMoneyMovementAnomalies", () => {
  beforeAll(async () => {
    await seedTestDatabase(env);
  });

  beforeEach(async () => {
    const db = getDb(env);
    await db.prepare("DELETE FROM payment_transfers").run();
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
    await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [],
      ids: { sandbox: SANDBOX_PROJECT_ID, production: PRODUCTION_PROJECT_ID },
    });
  });

  it("flags an hour whose value is far above the organization's busiest hour of the week", async () => {
    await seedBaseline("100.00");
    await seedMovement({ hoursBeforeChecked: 0, amount: "100000.00" });

    const result = await scan();

    expect(result.hourStart).toBe(new Date(CHECKED).toISOString());
    expect(result.anomalies).toEqual([
      {
        organizationId: TEST_ORG.id,
        kind: "transfer",
        token: USDC,
        count: 1,
        value: "100000.00",
        baselineMaxCount: 1,
        baselineMaxValue: "100.00",
        baselineActiveHours: 4,
      },
    ]);
  });

  it("flags an hour whose count is far above the busiest hour, at an ordinary value each", async () => {
    await seedBaseline("100.00");
    for (let index = 0; index <= MONEY_MOVEMENT_ANOMALY_FACTOR; index += 1) {
      await seedMovement({ hoursBeforeChecked: 0, amount: "1.00" });
    }

    const [anomaly] = (await scan()).anomalies;

    expect(anomaly).toMatchObject({ count: MONEY_MOVEMENT_ANOMALY_FACTOR + 1, value: "6.00" });
  });

  it("leaves an ordinary hour, one only a little busier, and failed or inbound rows alone", async () => {
    await seedBaseline("100.00");
    await seedMovement({ hoursBeforeChecked: 0, amount: "450.00" });
    await seedMovement({ hoursBeforeChecked: 0, amount: "1000000.00", status: "failed" });
    await seedMovement({ hoursBeforeChecked: 0, amount: "1000000.00", direction: "inbound" });

    expect((await scan()).anomalies).toEqual([]);
  });

  it("judges nothing for an organization without enough history yet", async () => {
    await seedBaseline("100.00", [5, 30]);
    await seedMovement({ hoursBeforeChecked: 0, amount: "100000.00" });

    expect((await scan()).anomalies).toEqual([]);
  });

  it("compares each movement kind and mint only with itself", async () => {
    await seedBaseline("100.00");
    // A batch chunk and a recurring collection with no history of their own,
    // and a large SOL amount against a USDC-only week: nothing to judge them by.
    await seedMovement({ hoursBeforeChecked: 0, amount: "100000.00", type: "transfer_batch" });
    await seedMovement({ hoursBeforeChecked: 0, amount: "100000.00", recurring: true });
    await seedMovement({ hoursBeforeChecked: 0, amount: "100000.00", token: "SOL" });
    for (const hoursBeforeChecked of [5, 30, 60]) {
      await seedMovement({ hoursBeforeChecked, amount: "10.00", recurring: true });
    }

    const anomalies = (await scan()).anomalies;

    expect(anomalies.map((anomaly) => [anomaly.kind, anomaly.token])).toEqual([
      ["recurring", USDC],
    ]);
  });

  it("reads only the environment the scan runs in", async () => {
    await seedBaseline("100.00");
    await seedMovement({ hoursBeforeChecked: 0, amount: "100000.00" });

    expect((await scan("production")).anomalies).toEqual([]);
  });

  it("keeps the hour's boundaries: a movement at the next hour's start is not counted", async () => {
    await seedBaseline("100.00");
    await seedMovement({ hoursBeforeChecked: -1, amount: "100000.00" });

    expect((await scan()).anomalies).toEqual([]);
  });
});
