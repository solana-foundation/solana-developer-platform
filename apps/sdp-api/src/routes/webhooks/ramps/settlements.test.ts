import type { RampSettlementEvent } from "@sdp/payments/ramps";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import type { AppContext } from "./processor";
import { applyRampSettlementEvent } from "./settlements";

const ORG_ID = "org_ramp_settlement_test";
const PROJECT_ID = "prj_ramp_settlement_test";
const USER_ID = "usr_ramp_settlement_test";

function context(): AppContext {
  return { env } as unknown as AppContext;
}

async function seedTransfer(input: {
  id: string;
  reference: string;
  status: string;
  type?: "onramp" | "offramp" | "transfer";
}) {
  const type = input.type ?? "onramp";
  await getDb(env)
    .prepare(
      `INSERT INTO payment_transfers (
         id, organization_id, project_id, wallet_id, source_address, destination_address,
         token, amount, memo, type, direction, status, provider, provider_reference,
         delivery_mode, fiat_currency, fiat_amount, provider_data, signature, serialized_tx,
         initiated_by_key_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?)`
    )
    .bind(
      input.id,
      ORG_ID,
      PROJECT_ID,
      "wallet_ramp_settlement_test",
      type === "offramp" ? "source" : null,
      type === "onramp" ? "destination" : "destination",
      "USDC",
      "10",
      null,
      type,
      type === "onramp" ? "inbound" : "outbound",
      input.status,
      "coinbase",
      input.reference,
      "hosted",
      "USD",
      "10",
      {},
      null,
      null,
      null,
      "2026-08-04T00:00:00.000Z",
      "2026-08-04T00:00:00.000Z"
    )
    .run();
}

async function readTransfer(id: string) {
  return getDb(env)
    .prepare(
      "SELECT status, amount, fiat_amount, error, provider_data FROM payment_transfers WHERE id = ?"
    )
    .bind(id)
    .first<{
      status: string;
      amount: string | null;
      fiat_amount: string | null;
      error: string | null;
      provider_data: Record<string, unknown>;
    }>();
}

describe("applyRampSettlementEvent", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await getDb(env).batch([
      getDb(env)
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(ORG_ID, "Ramp Settlement Test", "ramp-settlement-test", "enterprise", "active"),
      getDb(env)
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
        .bind(USER_ID, "ramp-settlement@example.com", 1, "active"),
      getDb(env)
        .prepare(
          `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          PROJECT_ID,
          ORG_ID,
          "Ramp Settlement Project",
          "ramp-settlement-project",
          "sandbox",
          "active",
          USER_ID
        ),
    ]);
  });

  afterEach(async () => {
    await clearTestDatabase(env);
  });

  it("never reopens a canceled transfer", async () => {
    await seedTransfer({ id: "xfr_canceled", reference: "order_canceled", status: "canceled" });

    await applyRampSettlementEvent(context(), {
      provider: "coinbase",
      kind: "settled",
      reference: "order_canceled",
      receivedAmount: "12",
    });

    expect(await readTransfer("xfr_canceled")).toMatchObject({
      status: "canceled",
      amount: "10",
    });
  });

  it("does not regress a settling transfer on an out-of-order event", async () => {
    await seedTransfer({ id: "xfr_settling", reference: "order_settling", status: "settling" });

    await applyRampSettlementEvent(context(), {
      provider: "coinbase",
      kind: "awaiting_payment",
      reference: "order_settling",
    });

    expect(await readTransfer("xfr_settling")).toMatchObject({ status: "settling" });
  });

  it("serializes concurrent terminal events", async () => {
    await seedTransfer({ id: "xfr_race", reference: "order_race", status: "settling" });
    const events: RampSettlementEvent[] = [
      { provider: "coinbase", kind: "settled", reference: "order_race", receivedAmount: "9" },
      { provider: "coinbase", kind: "failed", reference: "order_race", error: "declined" },
    ];

    await Promise.all(events.map((event) => applyRampSettlementEvent(context(), event)));

    const transfer = await readTransfer("xfr_race");
    expect(["completed", "failed"]).toContain(transfer?.status);
    if (transfer?.status === "completed") {
      expect(transfer.amount).toBe("9");
      expect(transfer.error).toBeNull();
    } else {
      expect(transfer?.amount).toBe("10");
      expect(transfer?.error).toBe("declined");
    }
  });

  it("makes exact retries idempotent", async () => {
    await seedTransfer({ id: "xfr_retry", reference: "order_retry", status: "settling" });
    const event: RampSettlementEvent = {
      provider: "coinbase",
      kind: "settled",
      reference: "order_retry",
      receivedAmount: "9",
    };

    await applyRampSettlementEvent(context(), event);
    await applyRampSettlementEvent(context(), { ...event, receivedAmount: "999" });

    expect(await readTransfer("xfr_retry")).toMatchObject({
      status: "completed",
      amount: "9",
    });
  });
});
