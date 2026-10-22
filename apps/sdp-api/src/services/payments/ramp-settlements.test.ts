import type { RampSettlementEvent } from "@sdp/payments/ramps/types";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { getDb } from "@/db/client";
import { createSystemPaymentsRepository } from "@/db/repositories/repository-factory";
import { RedisKVStore } from "@/runtime/kv-redis";
import * as moneyPathEvents from "@/runtime/money-path-events";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { applyRampSettlementEvent } from "./ramp-settlements";

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
  provider?: "moonpay" | "stripe";
  projectId?: string;
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
      input.projectId ?? PROJECT_ID,
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
      input.provider === undefined ? "moonpay" : input.provider,
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    await seedTestDatabase(env);
    await getDb(env).batch([
      getDb(env)
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(ORG_ID, "Ramp Settlement Test", "ramp-settlement-test", "enterprise", "active"),
      getDb(env)
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
        .bind(USER_ID, "ramp-settlement@example.com", 1, "active"),
    ]);
    await seedDefaultProjects(getDb(env), {
      organizationId: ORG_ID,
      createdBy: USER_ID,
      members: [],
      ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
    });
  });

  it("persists the provider signature for an on-ramp deposit", async () => {
    await seedTransfer({
      id: "xfr_onchain_settlement",
      reference: "order_onchain_settlement",
      status: "settling",
      type: "onramp",
      provider: "moonpay",
    });

    await applyRampSettlementEvent(env, "sandbox", {
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
      status: "settling",
      amount: "10",
      source_address: null,
      destination_address: "destination",
      signature: "provider-reported-signature",
      provider_data: {
        providerSettlement: {
          reference: "order_onchain_settlement",
          onchain: { amount: "9.75", destinationAddress: "provider-reported-destination" },
        },
      },
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

    await applyRampSettlementEvent(env, "sandbox", {
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
      status: "settling",
      amount: "10",
      fiat_amount: "10",
      source_address: "source",
      destination_address: "destination",
      signature: "sdp-submitted-signature",
      provider_data: {
        providerSettlement: { receivedAmount: "19.50" },
      },
    });
  });

  it("never reopens a canceled transfer", async () => {
    await seedTransfer({ id: "xfr_canceled", reference: "order_canceled", status: "canceled" });

    const result = await applyRampSettlementEvent(env, "sandbox", {
      provider: "moonpay",
      kind: "settled",
      reference: "order_canceled",
      receivedAmount: "12",
      deliveredAssetRail: "sol.solana",
    });

    expect(result).toEqual({
      applied: false,
      outcome: "refused",
      reason: "settled_after_cancel",
    });
    expect(await readTransfer("xfr_canceled")).toMatchObject({
      status: "canceled",
      amount: "10",
    });
  });

  it("leaves the transfer as it was when its settlement cannot be recorded", async () => {
    await seedTransfer({
      id: "xfr_unaudited_settle",
      reference: "order_unaudited_settle",
      status: "awaiting_payment",
    });
    // The ledger's pending witness is refused, so the record never seals.
    const witness = vi.spyOn(RedisKVStore.prototype, "compareAndSet").mockResolvedValueOnce(false);
    onTestFinished(() => witness.mockRestore());

    await expect(
      applyRampSettlementEvent(env, "sandbox", {
        provider: "moonpay",
        kind: "settled",
        reference: "order_unaudited_settle",
        receivedAmount: "12",
        onchain: {
          signature: "unaudited-signature",
          destinationAddress: "destination",
          amount: "12",
        },
      })
    ).rejects.toMatchObject({ name: "AuditPersistenceError" });

    expect(await readTransfer("xfr_unaudited_settle")).toMatchObject({
      status: "awaiting_payment",
      signature: null,
      provider_data: {},
    });
    const audits = await getDb(env)
      .prepare("SELECT count(*)::integer AS count FROM audit_logs WHERE resource_id = ?")
      .bind("xfr_unaudited_settle")
      .first<{ count: number }>();
    expect(audits).toMatchObject({ count: 0 });
  });

  it("refuses settlement when cancellation wins after the first read", async () => {
    await seedCounterparty();
    await seedTransfer({
      id: "xfr_cancel_race",
      reference: "order_cancel_race",
      status: "awaiting_payment",
      counterpartyId: COUNTERPARTY_ID,
    });

    // A settled event's writes run in the audit ledger's transaction, which
    // opens after the checks read: the cancel lands in between.
    const db = getDb(env);
    const runLedgerTransaction = db.lockedTransactionWithPostCommit?.bind(db);
    if (!runLedgerTransaction) throw new Error("The test database serializes audit writes");
    const settlementTransaction = vi
      .spyOn(db, "lockedTransactionWithPostCommit")
      .mockImplementationOnce(async (lockKey, callback, afterCommit, afterRollback, options) => {
        const canceled = await createSystemPaymentsRepository(env).transitionRampTransfer({
          transferId: "xfr_cancel_race",
          organizationId: ORG_ID,
          projectId: PROJECT_ID,
          transition: "canceled",
          updatedAt: new Date().toISOString(),
        });
        expect(canceled?.status).toBe("canceled");
        return runLedgerTransaction(lockKey, callback, afterCommit, afterRollback, options);
      });

    const result = await applyRampSettlementEvent(env, "sandbox", {
      provider: "moonpay",
      kind: "settled",
      reference: "order_cancel_race",
      receivedAmount: "12",
      providerCustomerId: "cust_cancel_race",
      onchain: {
        signature: "provider-reported-signature",
        sourceAddress: "provider-reported-source",
        destinationAddress: "provider-reported-destination",
        amount: "12",
      },
    });

    expect(settlementTransaction).toHaveBeenCalledOnce();
    expect(result).toEqual({
      applied: false,
      outcome: "refused",
      reason: "settled_after_cancel",
    });
    expect(await readTransfer("xfr_cancel_race")).toMatchObject({
      status: "canceled",
      amount: "10",
      fiat_amount: "10",
      source_address: null,
      destination_address: "destination",
      signature: null,
      provider_data: {},
    });
    const links = await db
      .prepare(
        `SELECT provider_customer_reference FROM counterparty_provider_accounts
         WHERE counterparty_id = ?`
      )
      .bind(COUNTERPARTY_ID)
      .all<{ provider_customer_reference: string }>();
    expect(links.results).toHaveLength(0);
  });

  it.each([
    { transferEnvironment: "production", eventEnvironment: "sandbox" },
    { transferEnvironment: "sandbox", eventEnvironment: "production" },
  ] as const)(
    "refuses a $eventEnvironment event for a $transferEnvironment transfer",
    async ({ transferEnvironment, eventEnvironment }) => {
      await seedTransfer({
        id: "xfr_environment_mismatch",
        reference: "order_environment_mismatch",
        status: "settling",
        provider: "stripe",
        projectId: transferEnvironment === "production" ? `${PROJECT_ID}_production` : PROJECT_ID,
      });

      const result = await applyRampSettlementEvent(env, eventEnvironment, {
        provider: "stripe",
        kind: "settled",
        reference: "order_environment_mismatch",
        receivedAmount: "12",
      });

      expect(result).toEqual({
        applied: false,
        outcome: "refused",
        reason: "environment_mismatch",
      });
      expect(await readTransfer("xfr_environment_mismatch")).toMatchObject({
        status: "settling",
        amount: "10",
      });
    }
  );

  it("revives an expired transfer when the provider proves the checkout completed", async () => {
    await seedTransfer({ id: "xfr_expired", reference: "order_expired", status: "expired" });

    await applyRampSettlementEvent(env, "sandbox", {
      provider: "moonpay",
      kind: "settled",
      reference: "order_expired",
      receivedAmount: "42",
    });

    expect(await readTransfer("xfr_expired")).toMatchObject({
      status: "settling",
      amount: "10",
    });
  });

  it("stores the payout currency beside the off-ramp's provider-reported payout", async () => {
    await seedTransfer({
      id: "xfr_payout_currency",
      reference: "order_payout_currency",
      status: "settling",
      type: "offramp",
      signature: "sdp-submitted-signature",
    });

    await applyRampSettlementEvent(env, "sandbox", {
      provider: "moonpay",
      kind: "settled",
      reference: "order_payout_currency",
      receivedAmount: "20.82",
      receivedCurrency: "USD",
    });

    expect(await readTransfer("xfr_payout_currency")).toMatchObject({
      status: "settling",
      fiat_amount: "10",
      provider_data: {
        providerSettlement: { receivedAmount: "20.82", receivedCurrency: "USD" },
        observedDelivery: { receivedAmount: "20.82", receivedCurrency: "USD" },
      },
    });
  });

  it("settles an off-ramp while its on-chain deposit is processing", async () => {
    await seedTransfer({
      id: "xfr_processing_deposit",
      reference: "order_processing_deposit",
      status: "processing",
      type: "offramp",
    });

    await applyRampSettlementEvent(env, "sandbox", {
      provider: "moonpay",
      kind: "settled",
      reference: "order_processing_deposit",
      receivedAmount: "42",
    });

    expect(await readTransfer("xfr_processing_deposit")).toMatchObject({
      status: "settling",
      amount: "10",
      fiat_amount: "10",
    });
  });

  it("does not regress a settling transfer on an out-of-order event", async () => {
    await seedTransfer({ id: "xfr_settling", reference: "order_settling", status: "settling" });

    await applyRampSettlementEvent(env, "sandbox", {
      provider: "moonpay",
      kind: "awaiting_payment",
      reference: "order_settling",
    });

    expect(await readTransfer("xfr_settling")).toMatchObject({ status: "settling" });
  });

  it("serializes concurrent terminal events", async () => {
    await seedTransfer({ id: "xfr_race", reference: "order_race", status: "settling" });
    const events: RampSettlementEvent[] = [
      {
        provider: "moonpay",
        kind: "settled",
        reference: "order_race",
        providerObservedAt: "2026-10-19T00:01:00.000Z",
        receivedAmount: "9",
      },
      {
        provider: "moonpay",
        kind: "failed",
        reference: "order_race",
        providerObservedAt: "2026-10-19T00:02:00.000Z",
        error: "declined",
      },
    ];

    const results = await Promise.all(
      events.map((event) => applyRampSettlementEvent(env, "sandbox", event))
    );
    expect(results.some((result) => result.outcome === "applied")).toBe(true);

    const transfer = await readTransfer("xfr_race");
    expect(transfer?.status).toBe("failed");
    expect(transfer?.amount).toBe("10");
    expect(transfer?.error).toBe("declined");
  });

  it("keeps the first provider customer canonical and records a later mismatch", async () => {
    await seedCounterparty();
    await seedTransfer({
      id: "xfr_first_wins",
      reference: "order_first_wins",
      status: "pending",
      counterpartyId: COUNTERPARTY_ID,
    });
    await applyRampSettlementEvent(env, "sandbox", {
      provider: "moonpay",
      kind: "awaiting_payment",
      reference: "order_first_wins",
      providerCustomerId: "cust_first",
    });
    await applyRampSettlementEvent(env, "sandbox", {
      provider: "moonpay",
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

  it("warns about a displaced provider customer once, not on every event", async () => {
    await seedCounterparty();
    await seedTransfer({
      id: "xfr_linked_first",
      reference: "order_linked_first",
      status: "pending",
      counterpartyId: COUNTERPARTY_ID,
    });
    await seedTransfer({
      id: "xfr_other_customer",
      reference: "order_other_customer",
      status: "pending",
      counterpartyId: COUNTERPARTY_ID,
    });
    await applyRampSettlementEvent(env, "sandbox", {
      provider: "moonpay",
      kind: "awaiting_payment",
      reference: "order_linked_first",
      providerCustomerId: "cust_first",
    });
    const events = vi.spyOn(moneyPathEvents, "logEvent");

    for (const kind of ["awaiting_payment", "settling", "settled"] as const) {
      await applyRampSettlementEvent(env, "sandbox", {
        provider: "moonpay",
        kind,
        reference: "order_other_customer",
        providerCustomerId: "cust_second",
      });
    }

    const mismatches = events.mock.calls.filter(
      ([, payload]) => payload.event === "sdp_api_counterparty_provider_reference_mismatch"
    );
    expect(mismatches).toEqual([
      [
        "warn",
        expect.objectContaining({
          canonical_reference: "cust_first",
          mismatched_reference: "cust_second",
        }),
      ],
    ]);
  });

  it("links the customer from the winning event and never from a refused one", async () => {
    await seedCounterparty();
    await seedTransfer({
      id: "xfr_refused_link",
      reference: "order_refused_link",
      status: "settling",
      counterpartyId: COUNTERPARTY_ID,
    });
    await applyRampSettlementEvent(env, "sandbox", {
      provider: "moonpay",
      kind: "failed",
      reference: "order_refused_link",
      error: "declined",
      providerCustomerId: "cust_winner",
    });

    await applyRampSettlementEvent(env, "sandbox", {
      provider: "moonpay",
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
      provider: "moonpay",
      kind: "settled",
      reference: "order_retry",
      receivedAmount: "9",
      onchain: { signature: "provider-settlement-signature" },
    };

    expect(await applyRampSettlementEvent(env, "sandbox", event)).toEqual({
      applied: true,
      outcome: "applied",
    });
    expect(
      await applyRampSettlementEvent(env, "sandbox", { ...event, receivedAmount: "999" })
    ).toEqual({
      applied: false,
      outcome: "ignored",
    });

    expect(await readTransfer("xfr_retry")).toMatchObject({
      status: "settling",
      amount: "10",
    });
  });
});
