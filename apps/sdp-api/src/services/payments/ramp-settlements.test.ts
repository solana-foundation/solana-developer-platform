import type { RampSettlementEvent } from "@sdp/payments/ramps";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { applyRampSettlementEvent } from "./ramp-settlements";

// The emit is asserted against the bus so a settled event that lost the status
// race is proven not to fire settlement workflows.
const dispatchWorkflowEvent = vi.hoisted(() => vi.fn(async () => 1));
vi.mock("@/services/workflows/event-bus", () => ({ dispatchWorkflowEvent }));

const ORG_ID = "org_ramp_settlement_test";
const PROJECT_ID = "prj_ramp_settlement_test";
const USER_ID = "usr_ramp_settlement_test";

const COUNTERPARTY_ID = "cpty_ramp_settlement_test";

async function seedCounterparty() {
  await getDb(env)
    .prepare(
      `INSERT INTO counterparties (
         id, organization_id, project_id, entity_type, display_name, status, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(COUNTERPARTY_ID, ORG_ID, PROJECT_ID, "individual", "Settlement Buyer", "active", USER_ID)
    .run();
}

async function seedTransfer(input: {
  id: string;
  reference: string;
  status: string;
  type?: "onramp" | "offramp" | "transfer";
  counterpartyId?: string;
  provider?: "coinbase" | "moonpay";
  signature?: string;
}) {
  const type = input.type ?? "onramp";
  await getDb(env)
    .prepare(
      `INSERT INTO payment_transfers (
         id, organization_id, project_id, wallet_id, counterparty_id, source_address,
         destination_address, token, amount, memo, type, direction, status, provider,
         provider_reference, delivery_mode, fiat_currency, fiat_amount, provider_data,
         signature, serialized_tx, initiated_by_key_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?)`
    )
    .bind(
      input.id,
      ORG_ID,
      PROJECT_ID,
      "wallet_ramp_settlement_test",
      input.counterpartyId === undefined ? null : input.counterpartyId,
      type === "offramp" ? "source" : null,
      type === "onramp" ? "destination" : "destination",
      "USDC",
      "10",
      null,
      type,
      type === "onramp" ? "inbound" : "outbound",
      input.status,
      input.provider === undefined ? "coinbase" : input.provider,
      input.reference,
      "hosted",
      "USD",
      "10",
      {},
      input.signature === undefined ? null : input.signature,
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
      `SELECT status, amount, fiat_amount, source_address, destination_address, signature,
              error, provider_data
       FROM payment_transfers WHERE id = ?`
    )
    .bind(id)
    .first<{
      status: string;
      amount: string | null;
      fiat_amount: string | null;
      source_address: string | null;
      destination_address: string | null;
      signature: string | null;
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

  it("persists the provider signature for an on-ramp deposit", async () => {
    await seedTransfer({
      id: "xfr_onchain_settlement",
      reference: "order_onchain_settlement",
      status: "settling",
      type: "onramp",
      provider: "moonpay",
    });

    await applyRampSettlementEvent(env, {
      provider: "moonpay",
      kind: "settled",
      reference: "order_onchain_settlement",
      onchain: {
        signature: "provider-reported-signature",
        sourceAddress: "provider-reported-source",
        destinationAddress: "provider-reported-destination",
        amount: "9.75",
      },
    });

    expect(await readTransfer("xfr_onchain_settlement")).toMatchObject({
      status: "completed",
      amount: "9.75",
      source_address: "provider-reported-source",
      destination_address: "provider-reported-destination",
      signature: "provider-reported-signature",
    });
  });

  it("preserves the submitted signature for an off-ramp payment", async () => {
    await seedTransfer({
      id: "xfr_onchain_payment",
      reference: "order_onchain_payment",
      status: "settling",
      type: "offramp",
      provider: "moonpay",
      signature: "sdp-submitted-signature",
    });

    await applyRampSettlementEvent(env, {
      provider: "moonpay",
      kind: "settled",
      reference: "order_onchain_payment",
      receivedAmount: "19.50",
      onchain: {
        signature: "provider-reported-signature",
        sourceAddress: "provider-reported-source",
        destinationAddress: "provider-reported-destination",
        amount: "9.75",
      },
    });

    expect(await readTransfer("xfr_onchain_payment")).toMatchObject({
      status: "completed",
      amount: "9.75",
      fiat_amount: "19.50",
      source_address: "provider-reported-source",
      destination_address: "provider-reported-destination",
      signature: "sdp-submitted-signature",
    });
  });

  it("never reopens a canceled transfer", async () => {
    await seedTransfer({ id: "xfr_canceled", reference: "order_canceled", status: "canceled" });

    await applyRampSettlementEvent(env, {
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

  it("revives an expired transfer when the provider proves the checkout completed", async () => {
    await seedTransfer({ id: "xfr_expired", reference: "order_expired", status: "expired" });

    await applyRampSettlementEvent(env, {
      provider: "coinbase",
      kind: "settled",
      reference: "order_expired",
      receivedAmount: "42",
    });

    expect(await readTransfer("xfr_expired")).toMatchObject({
      status: "completed",
      amount: "42",
    });
  });

  it("settles an off-ramp while its on-chain deposit is processing", async () => {
    await seedTransfer({
      id: "xfr_processing_deposit",
      reference: "order_processing_deposit",
      status: "processing",
      type: "offramp",
    });

    await applyRampSettlementEvent(env, {
      provider: "coinbase",
      kind: "settled",
      reference: "order_processing_deposit",
      receivedAmount: "42",
    });

    expect(await readTransfer("xfr_processing_deposit")).toMatchObject({
      status: "completed",
      amount: "10",
      fiat_amount: "42",
    });
  });

  it("does not regress a settling transfer on an out-of-order event", async () => {
    await seedTransfer({ id: "xfr_settling", reference: "order_settling", status: "settling" });

    await applyRampSettlementEvent(env, {
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

    dispatchWorkflowEvent.mockClear();
    await Promise.all(events.map((event) => applyRampSettlementEvent(env, event)));

    const transfer = await readTransfer("xfr_race");
    expect(["completed", "failed"]).toContain(transfer?.status);
    if (transfer?.status === "completed") {
      expect(transfer.amount).toBe("9");
      expect(transfer.error).toBeNull();
      expect(dispatchWorkflowEvent).toHaveBeenCalledTimes(1);
    } else {
      expect(transfer?.amount).toBe("10");
      expect(transfer?.error).toBe("declined");
      // The settled event lost the race: its transition did not land, so it
      // must not fire settlement workflows for a failed transfer.
      expect(dispatchWorkflowEvent).not.toHaveBeenCalled();
    }
  });

  it("does not emit settlement workflows for a settled event whose transition was refused", async () => {
    await seedTransfer({ id: "xfr_refused", reference: "order_refused", status: "settling" });
    await applyRampSettlementEvent(env, {
      provider: "coinbase",
      kind: "failed",
      reference: "order_refused",
      error: "declined",
    });

    dispatchWorkflowEvent.mockClear();
    await applyRampSettlementEvent(env, {
      provider: "coinbase",
      kind: "settled",
      reference: "order_refused",
      receivedAmount: "9",
    });

    expect(await readTransfer("xfr_refused")).toMatchObject({ status: "failed" });
    expect(dispatchWorkflowEvent).not.toHaveBeenCalled();
  });

  it("keeps the first provider customer canonical and records a later mismatch", async () => {
    await seedCounterparty();
    await seedTransfer({
      id: "xfr_first_wins",
      reference: "order_first_wins",
      status: "pending",
      counterpartyId: COUNTERPARTY_ID,
    });
    await applyRampSettlementEvent(env, {
      provider: "coinbase",
      kind: "awaiting_payment",
      reference: "order_first_wins",
      providerCustomerId: "cust_first",
    });
    await applyRampSettlementEvent(env, {
      provider: "coinbase",
      kind: "settled",
      reference: "order_first_wins",
      receivedAmount: "9",
      providerCustomerId: "cust_second",
    });

    const link = await getDb(env)
      .prepare(
        `SELECT provider_customer_reference, metadata FROM counterparty_provider_accounts
         WHERE counterparty_id = ?`
      )
      .bind(COUNTERPARTY_ID)
      .first<{ provider_customer_reference: string; metadata: Record<string, unknown> }>();
    expect(link?.provider_customer_reference).toBe("cust_first");
    expect(link?.metadata).toEqual({ mismatchedReferences: ["cust_second"] });
  });

  it("links the customer from the winning event and never from a refused one", async () => {
    await seedCounterparty();
    await seedTransfer({
      id: "xfr_refused_link",
      reference: "order_refused_link",
      status: "settling",
      counterpartyId: COUNTERPARTY_ID,
    });
    await applyRampSettlementEvent(env, {
      provider: "coinbase",
      kind: "failed",
      reference: "order_refused_link",
      error: "declined",
      providerCustomerId: "cust_winner",
    });

    await applyRampSettlementEvent(env, {
      provider: "coinbase",
      kind: "settled",
      reference: "order_refused_link",
      receivedAmount: "9",
      providerCustomerId: "cust_from_losing_event",
    });

    const links = await getDb(env)
      .prepare(
        `SELECT provider_customer_reference FROM counterparty_provider_accounts
         WHERE counterparty_id = ?`
      )
      .bind(COUNTERPARTY_ID)
      .all<{ provider_customer_reference: string }>();
    expect(links.results).toHaveLength(1);
    expect(links.results[0].provider_customer_reference).toBe("cust_winner");
  });

  it("makes exact retries idempotent", async () => {
    await seedTransfer({ id: "xfr_retry", reference: "order_retry", status: "settling" });
    const event: RampSettlementEvent = {
      provider: "coinbase",
      kind: "settled",
      reference: "order_retry",
      receivedAmount: "9",
    };

    await applyRampSettlementEvent(env, event);
    await applyRampSettlementEvent(env, { ...event, receivedAmount: "999" });

    expect(await readTransfer("xfr_retry")).toMatchObject({
      status: "completed",
      amount: "9",
    });
  });
});
