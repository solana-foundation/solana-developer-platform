import { runInClusterScope } from "@sdp/rpc/scope";
import type { ParsedTransaction } from "@sdp/rpc/solana";
import { SOL_MINT, wellKnownMint } from "@sdp/types/well-known-tokens";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { applyRampSettlementEvent } from "@/services/payments/ramp-settlements";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { type RampChainReader, verifyRampDeliveries } from "./verify-ramp-deliveries";

const getTransactionMock = vi.fn<RampChainReader["getTransaction"]>();
const getSignatureStatusesMock = vi.fn<RampChainReader["getSignatureStatuses"]>();
const chain: RampChainReader = {
  getTransaction: getTransactionMock,
  getSignatureStatuses: getSignatureStatusesMock,
};

const ORG = "org_ramp_delivery_test";
const USER = "usr_ramp_delivery_test";
const PROJECTS = {
  sandbox: "prj_ramp_delivery_sandbox",
  production: "prj_ramp_delivery_production",
};
const SIG_1 =
  "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy";
const SIG_2 =
  "5hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy";
const usdcMint = wellKnownMint("USDC", "devnet");
if (!usdcMint) throw new Error("USDC devnet mint missing");
const MINT: string = usdcMint;

async function seedTransfer(input: {
  id: string;
  reference: string;
  type?: "onramp" | "offramp";
  provider?: "moonpay" | "stripe";
  projectId?: string;
  signature?: string;
  signed?: boolean;
  amount?: string | null;
  token?: string;
}) {
  const type = input.type ?? "onramp";
  await getDb(env)
    .prepare(
      `INSERT INTO payment_transfers
       (id, organization_id, project_id, wallet_id, source_address, destination_address,
        token, amount, type, direction, status, provider, provider_reference,
        fiat_currency, fiat_amount, provider_data, signature, signed_transaction,
        last_valid_block_height,
        submission_started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'settling', ?, ?, 'USD', '10', '{}'::jsonb,
               ?, ?, ?::numeric, ?, ?, ?)`
    )
    .bind(
      input.id,
      ORG,
      input.projectId ?? PROJECTS.sandbox,
      "wallet_ramp_delivery_test",
      type === "offramp" ? "quoted-source" : null,
      type === "offramp" ? "quoted-deposit" : "quoted-destination",
      input.token ?? MINT,
      input.amount === undefined ? (type === "offramp" ? "1" : null) : input.amount,
      type,
      type === "offramp" ? "outbound" : "inbound",
      input.provider ?? "moonpay",
      input.reference,
      input.signature ?? null,
      input.signed ? "signed-by-sdp" : null,
      input.signed ? "100" : null,
      input.signed ? "2026-10-19T00:00:00.000Z" : null,
      "2026-10-19T00:00:00.000Z",
      "2026-10-19T00:00:00.000Z"
    )
    .run();
}

async function row(id: string) {
  return getDb(env)
    .prepare(
      "SELECT status, amount, fiat_amount, source_address, destination_address, provider_data FROM payment_transfers WHERE id = ?"
    )
    .bind(id)
    .first<{
      status: string;
      amount: string | null;
      fiat_amount: string | null;
      source_address: string | null;
      destination_address: string | null;
      provider_data: Record<string, unknown>;
    }>();
}

function sweep(environment: "sandbox" | "production" = "sandbox") {
  return runInClusterScope({ projectId: null, environment }, () =>
    verifyRampDeliveries(env, chain)
  );
}

const unixSeconds = (iso: string) => BigInt(Date.parse(iso) / 1000);
// seedTransfer creates every row at 2026-10-19T00:00:00Z.
const LANDED_AFTER_TRANSFER = unixSeconds("2026-10-19T00:05:00.000Z");

function landedToken(amount: string, owner = "quoted-destination", mint = MINT): ParsedTransaction {
  return {
    slot: 42n,
    blockTime: LANDED_AFTER_TRANSFER,
    executionResultKnown: true,
    err: null,
    preTokenBalances: [],
    postTokenBalances: [{ accountIndex: 0, mint, owner, amount, decimals: 6 }],
    instructions: [],
  };
}

describe("verifyRampDeliveries", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await seedTestDatabase(env);
    const db = getDb(env);
    await db.batch([
      db
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(ORG, "Ramp Delivery", "ramp-delivery", "enterprise", "active"),
      db
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind(USER, "ramp-delivery@example.com"),
    ]);
    await seedDefaultProjects(db, {
      organizationId: ORG,
      createdBy: USER,
      members: [],
      ids: PROJECTS,
    });
  });

  it("completes only after finalized quoted-mint delivery and leaves quoted fields intact", async () => {
    await seedTransfer({ id: "xfr_delivered", reference: "moonpay_delivered" });
    await applyRampSettlementEvent(env, "sandbox", {
      provider: "moonpay",
      kind: "settled",
      reference: "moonpay_delivered",
      onchain: { signature: SIG_1, destinationAddress: "quoted-destination", amount: "0.5" },
      receivedAmount: "0.5",
    });
    expect((await row("xfr_delivered"))?.status).toBe("settling");
    getTransactionMock.mockResolvedValue(landedToken("500000"));

    await sweep();

    expect(getTransactionMock).toHaveBeenCalledExactlyOnceWith(SIG_1);
    expect(getSignatureStatusesMock).not.toHaveBeenCalled();
    expect(await row("xfr_delivered")).toMatchObject({
      status: "completed",
      amount: "0.5",
      fiat_amount: "10",
      source_address: null,
      destination_address: "quoted-destination",
      provider_data: {
        verifiedDelivery: {
          signature: SIG_1,
          slot: 42,
          token: MINT,
          destinationAddress: "quoted-destination",
          amount: "0.5",
        },
      },
    });
  });

  it("keeps a quoted amount and records the actual chain delivery separately", async () => {
    await seedTransfer({ id: "xfr_quote_fixed", reference: "moonpay_quote_fixed", amount: "0.4" });
    await applyRampSettlementEvent(env, "sandbox", {
      provider: "moonpay",
      kind: "settled",
      reference: "moonpay_quote_fixed",
      onchain: { signature: SIG_1, destinationAddress: "quoted-destination" },
      receivedAmount: "0.5",
    });
    getTransactionMock.mockResolvedValue(landedToken("500000"));

    await sweep();

    expect(await row("xfr_quote_fixed")).toMatchObject({
      status: "completed",
      amount: "0.4",
      provider_data: { verifiedDelivery: { amount: "0.5" } },
    });
  });

  it("queues a settled webhook without a signature and accepts later proof", async () => {
    await seedTransfer({ id: "xfr_late_signature", reference: "moonpay_late_signature" });
    const event = {
      provider: "moonpay" as const,
      kind: "settled" as const,
      reference: "moonpay_late_signature",
      receivedAmount: "0.5",
    };
    await applyRampSettlementEvent(env, "sandbox", event);

    await sweep();
    expect(getTransactionMock).not.toHaveBeenCalled();
    expect(await row("xfr_late_signature")).toMatchObject({
      status: "settling",
      provider_data: { providerSettlement: { receivedAmount: "0.5" } },
    });

    await applyRampSettlementEvent(env, "sandbox", {
      ...event,
      onchain: { signature: SIG_1, destinationAddress: "quoted-destination" },
    });
    getTransactionMock.mockResolvedValue(landedToken("500000"));
    await sweep();
    expect((await row("xfr_late_signature"))?.status).toBe("completed");
  });

  it("ignores delayed untimed Stripe events after accepting settlement", async () => {
    await seedTransfer({
      id: "xfr_stripe_late_processing",
      reference: "cos_late_processing",
      provider: "stripe",
    });
    await applyRampSettlementEvent(env, "sandbox", {
      provider: "stripe",
      kind: "settled",
      reference: "cos_late_processing",
      onchain: { signature: SIG_1, destinationAddress: "quoted-destination" },
    });
    const settled = await row("xfr_stripe_late_processing");
    for (const kind of ["settling", "awaiting_payment", "failed"] as const) {
      const delayed = await applyRampSettlementEvent(env, "sandbox", {
        provider: "stripe",
        kind,
        reference: "cos_late_processing",
      });
      expect(delayed).toMatchObject({ applied: false, outcome: "ignored" });
      expect((await row("xfr_stripe_late_processing"))?.provider_data).toEqual(
        settled?.provider_data
      );
    }
    getTransactionMock.mockResolvedValue(landedToken("500000"));
    await sweep();
    expect((await row("xfr_stripe_late_processing"))?.status).toBe("completed");
  });

  it("drops a settled claim when a newer provider observation is not settled", async () => {
    await seedTransfer({ id: "xfr_provider_regressed", reference: "moonpay_provider_regressed" });
    await applyRampSettlementEvent(env, "sandbox", {
      provider: "moonpay",
      kind: "settled",
      reference: "moonpay_provider_regressed",
      providerObservedAt: "2026-10-19T00:01:00.000Z",
      onchain: { signature: SIG_1, destinationAddress: "quoted-destination" },
    });
    await applyRampSettlementEvent(env, "sandbox", {
      provider: "moonpay",
      kind: "settling",
      reference: "moonpay_provider_regressed",
      providerObservedAt: "2026-10-19T00:02:00.000Z",
    });
    getTransactionMock.mockResolvedValue(landedToken("500000"));

    await sweep();

    expect(getTransactionMock).not.toHaveBeenCalled();
    expect(await row("xfr_provider_regressed")).toMatchObject({
      status: "settling",
      provider_data: { providerSettlement: null, observedDelivery: { kind: "settling" } },
    });
  });

  it("verifies native SOL by the quoted wallet's lamport delta", async () => {
    await seedTransfer({
      id: "xfr_sol_delivery",
      reference: "moonpay_sol_delivery",
      token: SOL_MINT,
    });
    await applyRampSettlementEvent(env, "sandbox", {
      provider: "moonpay",
      kind: "settled",
      reference: "moonpay_sol_delivery",
      onchain: { signature: SIG_1, destinationAddress: "quoted-destination", amount: "0.5" },
      receivedAmount: "0.5",
    });
    getTransactionMock.mockResolvedValue({
      slot: 42n,
      blockTime: LANDED_AFTER_TRANSFER,
      executionResultKnown: true,
      err: null,
      accountKeys: ["fee-payer", "quoted-destination"],
      preBalances: [1_000_000_000n, 100_000_000n],
      postBalances: [499_995_000n, 600_000_000n],
      instructions: [],
    });

    await sweep();

    expect((await row("xfr_sol_delivery"))?.status).toBe("completed");
    expect((await row("xfr_sol_delivery"))?.amount).toBe("0.5");
    expect(getTransactionMock).toHaveBeenCalledTimes(1);
  });

  it("does not complete when the provider observation changes during the chain read", async () => {
    await seedTransfer({ id: "xfr_changed", reference: "moonpay_changed" });
    await applyRampSettlementEvent(env, "sandbox", {
      provider: "moonpay",
      kind: "settled",
      reference: "moonpay_changed",
      onchain: { signature: SIG_1, destinationAddress: "quoted-destination" },
      receivedAmount: "0.5",
    });
    getTransactionMock.mockImplementation(async () => {
      await getDb(env)
        .prepare(
          "UPDATE payment_transfers SET provider_data = jsonb_set(provider_data, '{providerSettlement,receivedAmount}', '\"0.6\"'::jsonb) WHERE id = ?"
        )
        .bind("xfr_changed")
        .run();
      return landedToken("500000");
    });

    await sweep();

    expect((await row("xfr_changed"))?.status).toBe("settling");
  });

  it.each([
    ["wrong owner", landedToken("500000", "attacker")],
    ["wrong mint", landedToken("500000", "quoted-destination", "wrong-mint")],
    ["short delivery", landedToken("499999")],
    ["failed transaction", { ...landedToken("500000"), err: { InstructionError: [0, "Custom"] } }],
    ["unknown execution", { ...landedToken("500000"), executionResultKnown: false }],
    [
      "a delivery from before the transfer",
      { ...landedToken("500000"), blockTime: unixSeconds("2026-10-09T00:00:00.000Z") },
    ],
    [
      "a delivery just past the clock-skew allowance",
      { ...landedToken("500000"), blockTime: unixSeconds("2026-10-18T23:57:59.000Z") },
    ],
    ["a delivery with no block time", { ...landedToken("500000"), blockTime: null }],
  ])("holds %s for operator reconciliation", async (_reason, transaction) => {
    await seedTransfer({ id: "xfr_bad_delivery", reference: "moonpay_bad_delivery" });
    await applyRampSettlementEvent(env, "sandbox", {
      provider: "moonpay",
      kind: "settled",
      reference: "moonpay_bad_delivery",
      onchain: { signature: SIG_1, destinationAddress: "quoted-destination" },
      receivedAmount: "0.5",
    });
    getTransactionMock.mockResolvedValue(transaction);

    await sweep();

    expect((await row("xfr_bad_delivery"))?.status).toBe("settling");
    expect((await row("xfr_bad_delivery"))?.amount).toBeNull();
  });

  it("accepts a delivery inside the clock-skew allowance", async () => {
    await seedTransfer({ id: "xfr_skewed_clock", reference: "moonpay_skewed_clock" });
    await applyRampSettlementEvent(env, "sandbox", {
      provider: "moonpay",
      kind: "settled",
      reference: "moonpay_skewed_clock",
      onchain: { signature: SIG_1, destinationAddress: "quoted-destination" },
      receivedAmount: "0.5",
    });
    getTransactionMock.mockResolvedValue({
      ...landedToken("500000"),
      blockTime: unixSeconds("2026-10-18T23:58:00.000Z"),
    });

    await sweep();

    expect((await row("xfr_skewed_clock"))?.status).toBe("completed");
  });

  it("does not read the chain when the provider names a different destination", async () => {
    await seedTransfer({ id: "xfr_wrong_destination", reference: "moonpay_wrong_destination" });
    await applyRampSettlementEvent(env, "sandbox", {
      provider: "moonpay",
      kind: "settled",
      reference: "moonpay_wrong_destination",
      onchain: { signature: SIG_1, destinationAddress: "attacker" },
      receivedAmount: "0.5",
    });

    await sweep();

    expect(getTransactionMock).not.toHaveBeenCalled();
    expect((await row("xfr_wrong_destination"))?.status).toBe("settling");
  });

  it("batches off-ramp signatures and completes only finalized SDP deposits", async () => {
    await seedTransfer({
      id: "xfr_off_final",
      reference: "moonpay_off_final",
      type: "offramp",
      signature: SIG_1,
      signed: true,
    });
    await seedTransfer({
      id: "xfr_off_pending",
      reference: "moonpay_off_pending",
      type: "offramp",
      signature: SIG_2,
      signed: true,
    });
    for (const [reference, signature] of [
      ["moonpay_off_final", SIG_1],
      ["moonpay_off_pending", SIG_2],
    ] as const) {
      await applyRampSettlementEvent(env, "sandbox", {
        provider: "moonpay",
        kind: "settled",
        reference,
        onchain: { signature, destinationAddress: "quoted-deposit", amount: "1" },
        receivedAmount: "9.5",
      });
    }
    getSignatureStatusesMock.mockResolvedValue([
      { slot: 50n, confirmations: null, confirmationStatus: "finalized", err: null },
      { slot: 51n, confirmations: 1n, confirmationStatus: "confirmed", err: null },
    ]);

    await sweep();

    expect(getSignatureStatusesMock).toHaveBeenCalledTimes(1);
    expect(getSignatureStatusesMock).toHaveBeenCalledWith([SIG_1, SIG_2]);
    expect(getTransactionMock).not.toHaveBeenCalled();
    expect((await row("xfr_off_final"))?.status).toBe("completed");
    expect(await row("xfr_off_final")).toMatchObject({
      amount: "1",
      fiat_amount: "10",
      destination_address: "quoted-deposit",
    });
    expect((await row("xfr_off_pending"))?.status).toBe("settling");
  });

  it("never completes a provider-reported deposit without SDP submission evidence", async () => {
    await seedTransfer({
      id: "xfr_unsubmitted",
      reference: "moonpay_unsubmitted",
      type: "offramp",
      signature: SIG_1,
    });
    await applyRampSettlementEvent(env, "sandbox", {
      provider: "moonpay",
      kind: "settled",
      reference: "moonpay_unsubmitted",
      onchain: { signature: SIG_1, destinationAddress: "quoted-deposit", amount: "1" },
    });

    await sweep();

    expect(getSignatureStatusesMock).not.toHaveBeenCalled();
    expect((await row("xfr_unsubmitted"))?.status).toBe("settling");
  });

  it("selects only the current environment's rows", async () => {
    await seedTransfer({
      id: "xfr_production",
      reference: "moonpay_production",
      projectId: PROJECTS.production,
    });
    await applyRampSettlementEvent(env, "production", {
      provider: "moonpay",
      kind: "settled",
      reference: "moonpay_production",
      onchain: { signature: SIG_1, destinationAddress: "quoted-destination" },
    });

    await sweep("sandbox");

    expect(getTransactionMock).not.toHaveBeenCalled();
    expect((await row("xfr_production"))?.status).toBe("settling");
  });

  it("retries unknown transactions and completes after they become finalized", async () => {
    await seedTransfer({ id: "xfr_retry_delivery", reference: "moonpay_retry_delivery" });
    await applyRampSettlementEvent(env, "sandbox", {
      provider: "moonpay",
      kind: "settled",
      reference: "moonpay_retry_delivery",
      onchain: { signature: SIG_1, destinationAddress: "quoted-destination" },
    });
    getTransactionMock.mockResolvedValueOnce(null).mockResolvedValueOnce(landedToken("500000"));

    await sweep();
    expect((await row("xfr_retry_delivery"))?.status).toBe("settling");
    await sweep();
    expect((await row("xfr_retry_delivery"))?.status).toBe("completed");
    expect(getTransactionMock).toHaveBeenCalledTimes(2);
  });
});
