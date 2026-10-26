import { runInClusterScope } from "@sdp/rpc/scope";
import type { ParsedTransaction } from "@sdp/rpc/solana";
import { SOL_MINT, SPL_TOKEN_PROGRAMS, wellKnownMint } from "@sdp/types/well-known-tokens";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { applyRampSettlementEvent } from "@/services/payments/ramp-settlements";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import {
  mintTermsAt,
  transferFeeExtension,
  transferFeeScheduleExtension,
} from "@/test/helpers/token-movement";
import { seedTestDatabase } from "@/test/mocks/db";
import { epochAt, type RampChainReader, verifyRampDeliveries } from "./verify-ramp-deliveries";

const getTransactionMock = vi.fn<RampChainReader["getTransaction"]>();
const getSignatureStatusesMock = vi.fn<RampChainReader["getSignatureStatuses"]>();
const readTokenTermsMock = vi.fn<RampChainReader["readTokenTerms"]>();
const epochOfSlotMock = vi.fn<RampChainReader["epochOfSlot"]>();
const chain: RampChainReader = {
  getTransaction: getTransactionMock,
  getSignatureStatuses: getSignatureStatusesMock,
  readTokenTerms: readTokenTermsMock,
  epochOfSlot: epochOfSlotMock,
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
      "SELECT status, amount, fiat_amount, source_address, destination_address, block_time, confirmed_at, provider_data FROM payment_transfers WHERE id = ?"
    )
    .bind(id)
    .first<{
      status: string;
      amount: string | null;
      fiat_amount: string | null;
      source_address: string | null;
      destination_address: string | null;
      block_time: string | null;
      confirmed_at: string | null;
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
    accountKeys: ["fee-payer"],
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
    // Every test delivery lands in epoch 900, after the fee entries test mints carry.
    epochOfSlotMock.mockResolvedValue(900n);
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
      block_time: "2026-10-19T00:05:00.000Z",
      confirmed_at: expect.any(String),
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

  it("audits the provider's settlement and the chain-verified completion", async () => {
    await seedTransfer({ id: "xfr_audited", reference: "moonpay_audited" });
    await applyRampSettlementEvent(env, "sandbox", {
      provider: "moonpay",
      kind: "settled",
      reference: "moonpay_audited",
      onchain: { signature: SIG_1, destinationAddress: "quoted-destination", amount: "0.5" },
      receivedAmount: "0.5",
    });
    getTransactionMock.mockResolvedValue(landedToken("500000"));

    await sweep();

    const { results } = await getDb(env)
      .prepare(
        `SELECT action, metadata FROM audit_logs
          WHERE resource_id = ? ORDER BY ledger_sequence`
      )
      .bind("xfr_audited")
      .all<{ action: string; metadata: string }>();
    expect(
      results.map((entry) => ({ action: entry.action, ...JSON.parse(entry.metadata) }))
    ).toEqual([
      expect.objectContaining({
        action: "settle",
        source: "provider",
        status: "settling",
        receivedAmount: "0.5",
      }),
      expect.objectContaining({
        action: "settle",
        source: "chain",
        status: "completed",
        signature: SIG_1,
        deliveredAmount: "0.5",
      }),
    ]);
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

  it("verifies a token delivery whose new account the ATA program topped up with lamports", async () => {
    await seedTransfer({ id: "xfr_prefunded_ata", reference: "moonpay_prefunded_ata" });
    await applyRampSettlementEvent(env, "sandbox", {
      provider: "moonpay",
      kind: "settled",
      reference: "moonpay_prefunded_ata",
      onchain: { signature: SIG_1, destinationAddress: "quoted-destination", amount: "0.5" },
      receivedAmount: "0.5",
    });
    // Someone sent the wallet's future token account 1 lamport, so creating it
    // ran an inner System transfer of the rest of its rent into it.
    getTransactionMock.mockResolvedValue({
      slot: 42n,
      blockTime: LANDED_AFTER_TRANSFER,
      accountKeys: ["fee-payer", "provider-account", "destination-account"],
      executionResultKnown: true,
      err: null,
      preTokenBalances: [],
      postTokenBalances: [
        { accountIndex: 2, mint: MINT, owner: "quoted-destination", amount: "500000", decimals: 6 },
      ],
      instructions: [
        {
          programId: SYSTEM_PROGRAM_ADDRESS,
          accounts: [],
          parsedType: "transfer",
          info: { source: "fee-payer", destination: "destination-account", lamports: 2_039_279 },
        },
        {
          programId: SPL_TOKEN_PROGRAMS["spl-token"],
          accounts: [],
          parsedType: "transferChecked",
          info: {
            source: "provider-account",
            destination: "destination-account",
            mint: MINT,
            tokenAmount: { amount: "500000", decimals: 6, uiAmountString: "0.5" },
          },
        },
      ],
    });

    await sweep();

    expect(await row("xfr_prefunded_ata")).toMatchObject({
      status: "completed",
      provider_data: { deliveryMismatch: null, verifiedDelivery: { amount: "0.5" } },
    });
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
      confirmed_at: expect.any(String),
    });
    expect(await row("xfr_off_pending")).toMatchObject({ status: "settling", confirmed_at: null });
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

  describe("delivery the chain contradicts", () => {
    async function settleUsdc(id: string, receivedAmount: string) {
      await seedTransfer({ id, reference: `moonpay_${id}` });
      await applyRampSettlementEvent(env, "sandbox", {
        provider: "moonpay",
        kind: "settled",
        reference: `moonpay_${id}`,
        providerObservedAt: "2026-10-19T00:06:00.000Z",
        onchain: { signature: SIG_1, destinationAddress: "quoted-destination" },
        receivedAmount,
      });
    }

    it("holds an underpaid delivery once and stops re-reading its transaction", async () => {
      await settleUsdc("xfr_underpaid", "20");
      getTransactionMock.mockResolvedValue(landedToken("500000"));

      await sweep();
      await sweep();

      expect(getTransactionMock).toHaveBeenCalledTimes(1);
      expect(await row("xfr_underpaid")).toMatchObject({
        status: "settling",
        confirmed_at: null,
        provider_data: {
          deliveryMismatch: {
            reason: "amount_mismatch",
            reportedAmount: "20",
            observedAmount: "0.5",
            checkedAt: expect.any(String),
          },
        },
      });
    });

    it("releases the hold when the provider reports again", async () => {
      await settleUsdc("xfr_rereported", "20");
      getTransactionMock.mockResolvedValue(landedToken("500000"));
      await sweep();

      await applyRampSettlementEvent(env, "sandbox", {
        provider: "moonpay",
        kind: "settled",
        reference: "moonpay_xfr_rereported",
        providerObservedAt: "2026-10-19T00:07:00.000Z",
        onchain: { signature: SIG_1, destinationAddress: "quoted-destination" },
        receivedAmount: "0.5",
      });
      expect((await row("xfr_rereported"))?.provider_data.deliveryMismatch).toBeNull();
      await sweep();

      expect(getTransactionMock).toHaveBeenCalledTimes(2);
      expect((await row("xfr_rereported"))?.status).toBe("completed");
    });

    it("holds a delivery that moved nothing to the quoted wallet", async () => {
      await settleUsdc("xfr_elsewhere", "0.5");
      getTransactionMock.mockResolvedValue(landedToken("500000", "someone-else"));

      await sweep();

      expect((await row("xfr_elsewhere"))?.provider_data.deliveryMismatch).toMatchObject({
        reason: "not_delivered",
      });
    });

    it("holds a reported signature still missing an hour after the report", async () => {
      await settleUsdc("xfr_never_landed", "0.5");
      getTransactionMock.mockResolvedValue(null);
      await sweep();
      expect((await row("xfr_never_landed"))?.provider_data).not.toHaveProperty(
        "deliveryMismatch.reason"
      );

      await getDb(env)
        .prepare("UPDATE payment_transfers SET updated_at = ? WHERE id = ?")
        .bind(new Date(Date.now() - 61 * 60 * 1000).toISOString(), "xfr_never_landed")
        .run();
      await sweep();

      expect((await row("xfr_never_landed"))?.provider_data.deliveryMismatch).toMatchObject({
        reason: "transaction_not_found",
        reportedAmount: "0.5",
      });
    });

    it("keeps checking a missing transaction and completes once it lands", async () => {
      await settleUsdc("xfr_late_rpc", "0.5");
      await getDb(env)
        .prepare("UPDATE payment_transfers SET updated_at = ? WHERE id = ?")
        .bind(new Date(Date.now() - 61 * 60 * 1000).toISOString(), "xfr_late_rpc")
        .run();
      const updatedAt = async () =>
        (
          await getDb(env)
            .prepare("SELECT updated_at FROM payment_transfers WHERE id = ?")
            .bind("xfr_late_rpc")
            .first<{ updated_at: string }>()
        )?.updated_at;
      getTransactionMock.mockResolvedValue(null);
      await sweep();
      expect((await row("xfr_late_rpc"))?.provider_data.deliveryMismatch).toMatchObject({
        reason: "transaction_not_found",
      });
      const heldAt = await updatedAt();

      // A second miss writes nothing new; the RPC catching up completes the buy.
      await sweep();
      expect(await updatedAt()).toBe(heldAt);
      getTransactionMock.mockResolvedValue(landedToken("500000"));
      await sweep();

      expect(await row("xfr_late_rpc")).toMatchObject({
        status: "completed",
        provider_data: { deliveryMismatch: null },
      });
      expect(getTransactionMock).toHaveBeenCalledTimes(3);
    });

    it("holds an off-ramp whose SDP deposit failed onchain", async () => {
      await seedTransfer({
        id: "xfr_failed_deposit",
        reference: "moonpay_failed_deposit",
        type: "offramp",
        signature: SIG_1,
        signed: true,
      });
      await applyRampSettlementEvent(env, "sandbox", {
        provider: "moonpay",
        kind: "settled",
        reference: "moonpay_failed_deposit",
        onchain: { signature: SIG_1, destinationAddress: "quoted-deposit", amount: "1" },
        receivedAmount: "9.5",
      });
      getSignatureStatusesMock.mockResolvedValue([
        {
          slot: 50n,
          confirmations: null,
          confirmationStatus: "finalized",
          err: { InstructionError: [0, { Custom: 1 }] },
        },
      ]);

      await sweep();
      await sweep();

      expect(getSignatureStatusesMock).toHaveBeenCalledTimes(1);
      expect(await row("xfr_failed_deposit")).toMatchObject({
        status: "settling",
        provider_data: {
          deliveryMismatch: { reason: "transaction_failed", reportedAmount: "1" },
        },
      });
    });
  });

  describe("token movement legs (ADR 0012)", () => {
    const PYUSD = wellKnownMint("PYUSD", "devnet");
    if (!PYUSD) throw new Error("PYUSD devnet mint missing");
    const PYUSD_MINT: string = PYUSD;

    async function legOf(transferId: string) {
      return getDb(env)
        .prepare(
          `SELECT asset_kind, mint, token_program, decimals, basis, quoted_debit::text AS quoted_debit,
                  quoted_fee::text AS quoted_fee, quoted_credit::text AS quoted_credit,
                  observed_debit::text AS observed_debit, observed_fee::text AS observed_fee,
                  observed_credit::text AS observed_credit, as_of_slot::text AS as_of_slot,
                  verified_by, verification_state, verification_reason
             FROM token_movement_legs WHERE payment_transfer_id = ?`
        )
        .bind(transferId)
        .first<Record<string, unknown>>();
    }

    /**
     * A fee-mint delivery: each instruction debits 1 PYUSD (one by default), the
     * destination receives `credit`.
     */
    function landedFeeMint(
      credit: string,
      type: "transferChecked" | "transferCheckedWithFee",
      fee: string | null,
      transfers = 1
    ): ParsedTransaction {
      const transfer = {
        source: "provider-account",
        destination: "destination-account",
        mint: PYUSD_MINT,
        tokenAmount: { amount: "1000000", decimals: 6, uiAmountString: "1" },
      };
      const info =
        fee === null ? transfer : { ...transfer, feeAmount: { amount: fee, decimals: 6 } };
      return {
        slot: 43n,
        blockTime: LANDED_AFTER_TRANSFER,
        accountKeys: ["fee-payer", "provider-account", "destination-account"],
        executionResultKnown: true,
        err: null,
        preTokenBalances: [],
        postTokenBalances: [
          {
            accountIndex: 2,
            mint: PYUSD_MINT,
            owner: "quoted-destination",
            amount: credit,
            decimals: 6,
          },
        ],
        instructions: Array.from({ length: transfers }, () => ({
          programId: SPL_TOKEN_PROGRAMS["token-2022"],
          accounts: [],
          parsedType: type,
          info,
        })),
      };
    }

    async function settleOnramp(id: string, token: string, reported: string) {
      await seedTransfer({ id, reference: `moonpay_${id}`, token });
      await applyRampSettlementEvent(env, "sandbox", {
        provider: "moonpay",
        kind: "settled",
        reference: `moonpay_${id}`,
        onchain: { signature: SIG_1, destinationAddress: "quoted-destination", amount: reported },
        receivedAmount: reported,
      });
    }

    it("records a verified on-ramp's leg from the raw balance change, as a receipt", async () => {
      await settleOnramp("xfr_leg_usdc", MINT, "0.5");
      getTransactionMock.mockResolvedValue(landedToken("500000"));

      await sweep();

      expect(await legOf("xfr_leg_usdc")).toEqual({
        asset_kind: "token",
        mint: MINT,
        token_program: "spl-token",
        decimals: 6,
        basis: "credit",
        quoted_debit: "500000",
        quoted_fee: "0",
        quoted_credit: "500000",
        observed_debit: "500000",
        observed_fee: "0",
        observed_credit: "500000",
        as_of_slot: "42",
        verified_by: "chain",
        verification_state: "verified",
        verification_reason: "chain_delta_matched",
      });
      expect(readTokenTermsMock).not.toHaveBeenCalled();
    });

    it("records native SOL as the native asset", async () => {
      await settleOnramp("xfr_leg_sol", SOL_MINT, "0.5");
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

      expect(await legOf("xfr_leg_sol")).toMatchObject({
        asset_kind: "native",
        mint: null,
        decimals: 9,
        observed_credit: "500000000",
        as_of_slot: null,
      });
    });

    it("accepts a provider reporting the debit when the stated fee explains the credit", async () => {
      await settleOnramp("xfr_leg_fee", PYUSD_MINT, "1");
      getTransactionMock.mockResolvedValue(
        landedFeeMint("995000", "transferCheckedWithFee", "5000")
      );

      await sweep();

      expect((await row("xfr_leg_fee"))?.status).toBe("completed");
      expect(await legOf("xfr_leg_fee")).toMatchObject({
        quoted_debit: "1000000",
        quoted_fee: "5000",
        quoted_credit: "995000",
        observed_credit: "995000",
        verification_state: "verified",
      });
      expect(readTokenTermsMock).not.toHaveBeenCalled();
    });

    it("reads the mint's fee schedule only when a TransferChecked states no fee", async () => {
      await settleOnramp("xfr_leg_fee_rule", PYUSD_MINT, "1");
      getTransactionMock.mockResolvedValue(landedFeeMint("995000", "transferChecked", null));
      readTokenTermsMock.mockResolvedValue(
        mintTermsAt(PYUSD_MINT, "token-2022", {
          decimals: 6,
          extensions: [transferFeeExtension(50, 1_000_000n)],
        })
      );

      await sweep();

      expect(readTokenTermsMock).toHaveBeenCalledTimes(1);
      expect((await row("xfr_leg_fee_rule"))?.status).toBe("completed");
      expect(await legOf("xfr_leg_fee_rule")).toMatchObject({
        quoted_debit: "1000000",
        quoted_fee: "5000",
        quoted_credit: "995000",
      });
    });

    it("counts what the wallet burned in the same transaction as moved out, never as a fee", async () => {
      await settleOnramp("xfr_leg_burn", PYUSD_MINT, "1");
      const landed = landedFeeMint("100000", "transferChecked", null);
      getTransactionMock.mockResolvedValue({
        ...landed,
        instructions: [
          ...landed.instructions,
          {
            programId: SPL_TOKEN_PROGRAMS["token-2022"],
            accounts: [],
            parsedType: "burnChecked",
            info: {
              account: "destination-account",
              mint: PYUSD_MINT,
              tokenAmount: { amount: "900000", decimals: 6, uiAmountString: "0.9" },
            },
          },
        ],
      });

      await sweep();

      expect((await row("xfr_leg_burn"))?.status).toBe("completed");
      expect(await legOf("xfr_leg_burn")).toMatchObject({
        quoted_debit: "1000000",
        quoted_fee: "0",
        quoted_credit: "1000000",
        verification_state: "verified",
      });
      expect(readTokenTermsMock).not.toHaveBeenCalled();
    });

    it("charges the fee per transfer: two capped transfers withhold two caps", async () => {
      await settleOnramp("xfr_leg_split", PYUSD_MINT, "2");
      // 1% of each 1 PYUSD transfer is 10 000, capped at 5 000 per transfer.
      getTransactionMock.mockResolvedValue(landedFeeMint("1990000", "transferChecked", null, 2));
      readTokenTermsMock.mockResolvedValue(
        mintTermsAt(PYUSD_MINT, "token-2022", {
          decimals: 6,
          extensions: [transferFeeExtension(100, 5_000n)],
        })
      );

      await sweep();

      expect((await row("xfr_leg_split"))?.status).toBe("completed");
      expect(await legOf("xfr_leg_split")).toMatchObject({
        quoted_debit: "2000000",
        quoted_fee: "10000",
        quoted_credit: "1990000",
      });
    });

    it("holds a debit report for a person when both of the mint's fee entries came after the delivery", async () => {
      await settleOnramp("xfr_leg_old_fee", PYUSD_MINT, "1");
      getTransactionMock.mockResolvedValue(landedFeeMint("995000", "transferChecked", null));
      // The delivery landed in epoch 900; the mint now keeps entries from 950 and
      // 960. Entries only get newer, so no later read can price that fee.
      const later = { epoch: 950n, maximumFee: 0n, transferFeeBasisPoints: 0 };
      readTokenTermsMock.mockResolvedValue(
        mintTermsAt(PYUSD_MINT, "token-2022", {
          decimals: 6,
          extensions: [transferFeeScheduleExtension(later, { ...later, epoch: 960n })],
        })
      );

      await sweep();
      await sweep();

      expect(getTransactionMock).toHaveBeenCalledTimes(1);
      expect(await row("xfr_leg_old_fee")).toMatchObject({
        status: "settling",
        provider_data: {
          deliveryMismatch: {
            reason: "amount_mismatch",
            reportedAmount: "1",
            observedAmount: "0.995",
          },
        },
      });
      expect(await legOf("xfr_leg_old_fee")).toBeNull();
    });

    it("records the chain's debit and fee for a credit report whose fee entries came after it", async () => {
      await settleOnramp("xfr_leg_old_fee_credit", PYUSD_MINT, "0.995");
      getTransactionMock.mockResolvedValue(landedFeeMint("995000", "transferChecked", null));
      const later = { epoch: 950n, maximumFee: 0n, transferFeeBasisPoints: 0 };
      readTokenTermsMock.mockResolvedValue(
        mintTermsAt(PYUSD_MINT, "token-2022", {
          decimals: 6,
          extensions: [transferFeeScheduleExtension(later, { ...later, epoch: 960n })],
        })
      );

      await sweep();

      expect(await row("xfr_leg_old_fee_credit")).toMatchObject({ status: "completed" });
      expect(await legOf("xfr_leg_old_fee_credit")).toMatchObject({
        observed_debit: "1000000",
        observed_fee: "5000",
        observed_credit: "995000",
        verification_state: "verified",
      });
    });

    it("still holds a short delivery whose fee entries came after it, which no fee could explain", async () => {
      // The quote is 2 PYUSD; the transfer debited 1 and credited 0.995.
      await seedTransfer({
        id: "xfr_leg_old_fee_short",
        reference: "moonpay_xfr_leg_old_fee_short",
        token: PYUSD_MINT,
        amount: "2",
      });
      await applyRampSettlementEvent(env, "sandbox", {
        provider: "moonpay",
        kind: "settled",
        reference: "moonpay_xfr_leg_old_fee_short",
        onchain: { signature: SIG_1, destinationAddress: "quoted-destination", amount: "1" },
        receivedAmount: "1",
      });
      getTransactionMock.mockResolvedValue(landedFeeMint("995000", "transferChecked", null));
      const later = { epoch: 950n, maximumFee: 0n, transferFeeBasisPoints: 0 };
      readTokenTermsMock.mockResolvedValue(
        mintTermsAt(PYUSD_MINT, "token-2022", {
          decimals: 6,
          extensions: [transferFeeScheduleExtension(later, { ...later, epoch: 960n })],
        })
      );

      await sweep();

      expect(await row("xfr_leg_old_fee_short")).toMatchObject({
        status: "settling",
        provider_data: { deliveryMismatch: { reason: "amount_mismatch" } },
      });
    });

    it("holds amount_mismatch when no fee rule explains a debit report, and records no leg", async () => {
      await settleOnramp("xfr_leg_unexplained", PYUSD_MINT, "1");
      getTransactionMock.mockResolvedValue(landedFeeMint("995000", "transferChecked", null));
      readTokenTermsMock.mockResolvedValue(
        mintTermsAt(PYUSD_MINT, "token-2022", {
          decimals: 6,
          extensions: [transferFeeExtension(0, 0n)],
        })
      );

      await sweep();

      expect(await row("xfr_leg_unexplained")).toMatchObject({
        status: "settling",
        provider_data: {
          deliveryMismatch: {
            reason: "amount_mismatch",
            reportedAmount: "1",
            observedAmount: "0.995",
          },
        },
      });
      expect(await legOf("xfr_leg_unexplained")).toBeNull();
    });

    /** An off-ramp deposit SDP built whose confirmation never came back: its leg is pending. */
    async function seedPendingDeposit(id: string) {
      await seedTransfer({
        id,
        reference: `moonpay_${id}`,
        type: "offramp",
        signature: SIG_1,
        signed: true,
      });
      await getDb(env)
        .prepare(
          `INSERT INTO token_movement_legs
             (id, organization_id, project_id, payment_transfer_id, asset_kind, mint, token_program,
              decimals, basis, quoted_debit, quoted_fee, quoted_credit, as_of_slot, as_of_unix_timestamp)
           VALUES (?, ?, ?, ?, 'token', ?, 'spl-token', 6, 'credit', 1000000, 0, 1000000, 40, 1792000000)`
        )
        .bind(`tml_${id}`, ORG, PROJECTS.sandbox, id, MINT)
        .run();
      await applyRampSettlementEvent(env, "sandbox", {
        provider: "moonpay",
        kind: "settled",
        reference: `moonpay_${id}`,
        onchain: { signature: SIG_1, destinationAddress: "quoted-deposit", amount: "1" },
        receivedAmount: "9.5",
      });
    }

    it("settles a timed-out off-ramp deposit's pending leg once its signature finalizes", async () => {
      await seedPendingDeposit("xfr_timed_out_deposit");
      expect((await legOf("xfr_timed_out_deposit"))?.verification_state).toBe("pending");
      getSignatureStatusesMock.mockResolvedValue([
        { slot: 50n, confirmations: null, confirmationStatus: "finalized", err: null },
      ]);

      await sweep();

      expect((await row("xfr_timed_out_deposit"))?.status).toBe("completed");
      expect(await legOf("xfr_timed_out_deposit")).toMatchObject({
        verified_by: "construction",
        verification_state: "verified",
        verification_reason: "sdp_built_transfer_landed",
      });
    });

    it("marks a failed off-ramp deposit's pending leg as not executed with its hold", async () => {
      await seedPendingDeposit("xfr_failed_leg_deposit");
      getSignatureStatusesMock.mockResolvedValue([
        {
          slot: 50n,
          confirmations: null,
          confirmationStatus: "finalized",
          err: { InstructionError: [0, { Custom: 1 }] },
        },
      ]);

      await sweep();

      expect(await legOf("xfr_failed_leg_deposit")).toMatchObject({
        verification_state: "not_required",
        verification_reason: "movement_not_executed",
      });
    });
  });
});

describe("epochAt", () => {
  it("divides a schedule without warmup evenly, as mainnet and devnet are", () => {
    const schedule = { firstNormalEpoch: 0n, firstNormalSlot: 0n, slotsPerEpoch: 432_000n };
    expect(epochAt(schedule, 0n)).toBe(0n);
    expect(epochAt(schedule, 431_999n)).toBe(0n);
    expect(epochAt(schedule, 432_000n)).toBe(1n);
    expect(epochAt(schedule, 514_177_405n)).toBe(1_190n);
  });

  it("doubles warmup epochs from 32 slots until the first normal slot", () => {
    // Warmup epochs 0..13 are 32, 64, ... 262 144 slots long; epoch 14 starts at slot 524 256.
    const schedule = { firstNormalEpoch: 14n, firstNormalSlot: 524_256n, slotsPerEpoch: 432_000n };
    expect([0n, 31n, 32n, 95n, 96n].map((slot) => epochAt(schedule, slot))).toEqual([
      0n,
      0n,
      1n,
      1n,
      2n,
    ]);
    expect(epochAt(schedule, 524_255n)).toBe(13n);
    expect(epochAt(schedule, 524_256n)).toBe(14n);
    expect(epochAt(schedule, 524_256n + 432_000n)).toBe(15n);
  });
});
