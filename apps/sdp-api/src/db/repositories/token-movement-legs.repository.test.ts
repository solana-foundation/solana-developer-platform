import { quoteMovement } from "@sdp/solana/movement-quote";
import { parseTokenAmount } from "@sdp/solana/token-amount";
import { decodeTokenTerms, type MintTokenTerms } from "@sdp/solana/token-terms";
import { SOL_MINT, SPL_TOKEN_PROGRAMS } from "@sdp/types/well-known-tokens";
import {
  address,
  getAddressDecoder,
  lamports,
  type ReadonlyUint8Array,
  unixTimestamp,
} from "@solana/kit";
import { getSysvarClockEncoder, SYSVAR_CLOCK_ADDRESS } from "@solana/sysvars";
import { type ExtensionArgs, getMintEncoder } from "@solana-program/token-2022";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { createTenantScope } from "@/lib/tenant-scope";
import { claimOfframpDepositWithLeg, recordQuotedTransfer } from "@/services/token-movement/record";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { seedProjectCryptoWalletCounterparty } from "@/test/helpers/counterparties";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { required } from "@/test/helpers/required";
import { nativeQuote, transferFeeExtension } from "@/test/helpers/token-movement";
import { seedTestDatabase } from "@/test/mocks/db";
import { createPostgresPaymentTransferBatchesRepository } from "./payment-transfer-batches.repository.postgres";
import type { CreatePaymentTransferInput } from "./payments.repository";
import { createPostgresPaymentsRepository } from "./payments.repository.postgres";
import { createPostgresTokenMovementLegsRepository } from "./token-movement-legs.repository";

const PROJECT_ID = "prj_token_movement_legs";
const OTHER_PROJECT_ID = `${PROJECT_ID}_production`;
const CUSTODY_WALLET_ID = "cwlt_token_movement_legs";
const WALLET_ID = "wallet_token_movement_legs";
const MINT = getAddressDecoder().decode(new Uint8Array(32).fill(7));
const AUTHORITY = getAddressDecoder().decode(new Uint8Array(32).fill(8));

const tenant = createTenantScope({ organizationId: TEST_ORG.id, projectId: PROJECT_ID });
const otherTenant = createTenantScope({ organizationId: TEST_ORG.id, projectId: OTHER_PROJECT_ID });

function encoded(at: string, owner: string, data: ReadonlyUint8Array) {
  return {
    address: address(at),
    data,
    executable: false,
    lamports: lamports(1n),
    programAddress: address(owner),
    space: 0n,
  };
}

/** A 6-decimal Token-2022 mint's terms, read at epoch 900. */
function mintTerms(extensions: ExtensionArgs[]): MintTokenTerms {
  return decodeTokenTerms(
    { kind: "mint", mint: MINT },
    {
      mint: encoded(
        MINT,
        SPL_TOKEN_PROGRAMS["token-2022"],
        getMintEncoder().encode({
          mintAuthority: AUTHORITY,
          supply: 0n,
          decimals: 6,
          isInitialized: true,
          freezeAuthority: null,
          extensions,
        })
      ),
      clock: encoded(
        SYSVAR_CLOCK_ADDRESS,
        "Sysvar1111111111111111111111111111111111111",
        getSysvarClockEncoder().encode({
          slot: 4_200n,
          epochStartTimestamp: unixTimestamp(1_799_000_000n),
          epoch: 900n,
          leaderScheduleEpoch: 901n,
          unixTimestamp: unixTimestamp(1_800_000_000n),
        })
      ),
    }
  );
}

function tokenQuote(terms: MintTokenTerms, amount: string, basis: "debit" | "credit") {
  return quoteMovement(terms, {
    asset: terms.asset,
    amount: parseTokenAmount(amount, terms.decimals),
    basis,
  });
}

function transferInput(id: string): Omit<CreatePaymentTransferInput, "amount"> {
  return {
    id,
    organizationId: TEST_ORG.id,
    projectId: PROJECT_ID,
    custodyWalletId: CUSTODY_WALLET_ID,
    walletId: WALLET_ID,
    counterpartyId: null,
    sourceAddress: "Source111",
    destinationAddress: "Dest111",
    token: MINT,
    memo: null,
    type: "transfer",
    direction: "outbound",
    status: "processing",
    provider: null,
    providerReference: null,
    deliveryMode: null,
    fiatCurrency: null,
    fiatAmount: null,
    providerData: {},
    serializedTx: null,
    signature: null,
    slot: null,
    initiatedByKeyId: null,
  };
}

describe("token movement legs (postgres)", () => {
  const db = () => getDb(env);
  const legs = () => createPostgresTokenMovementLegsRepository(db(), tenant);
  const payments = () => createPostgresPaymentsRepository(db(), tenant);

  beforeEach(async () => {
    await seedTestDatabase(env);
    await db()
      .prepare(
        "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    await db()
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    await seedDefaultProjects(db(), {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [],
      ids: { sandbox: PROJECT_ID, production: OTHER_PROJECT_ID },
    });
    await seedTestCustodyRows(env, {
      configs: [
        {
          id: "cfg_token_movement_legs",
          organizationId: TEST_ORG.id,
          projectId: PROJECT_ID,
          provider: "local",
          configEncrypted: "encrypted",
          status: "active",
        },
      ],
      wallets: [
        {
          id: CUSTODY_WALLET_ID,
          owner: { kind: "config", custodyConfigId: "cfg_token_movement_legs" },
          walletId: WALLET_ID,
          publicKey: "Source111",
          label: null,
          purpose: null,
          status: "active",
        },
      ],
    });
  });

  it("writes a transfer with its leg, the row's amount the quote's debit", async () => {
    const feeTerms = mintTerms([transferFeeExtension(50, 5_000n)]);
    const quote = tokenQuote(feeTerms, "0.995", "credit");

    const row = await recordQuotedTransfer(db(), tenant, transferInput("xfr_leg_fee"), quote);

    expect(row.amount).toBe("1");
    const [leg] = (await legs().listLegsByTransfers([row.id])).get(row.id) ?? [];
    expect(leg).toMatchObject({
      owner: { kind: "transfer", transferId: row.id },
      asset: { kind: "token", mint: MINT, program: "token-2022" },
      decimals: 6,
      basis: "credit",
      quoted: { debit: 1_000_000n, fee: 5_000n, credit: 995_000n },
      feeEpoch: 900n,
      asOf: { slot: 4_200n, unixTimestamp: 1_800_000_000n },
      displayRule: null,
      observed: null,
      verification: { state: "pending", reason: null },
    });
  });

  it("round-trips a scaled mint's display rule and a native leg's fixed terms", async () => {
    const scaled = mintTerms([
      {
        __kind: "ScaledUiAmountConfig",
        authority: AUTHORITY,
        multiplier: 1.5,
        newMultiplierEffectiveTimestamp: 1_900_000_000n,
        newMultiplier: 3,
      },
    ]);
    const scaledRow = await recordQuotedTransfer(
      db(),
      tenant,
      transferInput("xfr_leg_scaled"),
      tokenQuote(scaled, "2", "debit")
    );
    const nativeRow = await recordQuotedTransfer(
      db(),
      tenant,
      transferInput("xfr_leg_native"),
      nativeQuote("0.5", "debit")
    );

    const byTransfer = await legs().listLegsByTransfers([scaledRow.id, nativeRow.id]);
    expect(byTransfer.get(scaledRow.id)?.[0]?.displayRule).toEqual(scaled.display);
    expect(byTransfer.get(nativeRow.id)?.[0]).toMatchObject({
      asset: { kind: "native" },
      decimals: 9,
      quoted: { debit: 500_000_000n, fee: 0n, credit: 500_000_000n },
      feeEpoch: null,
      asOf: null,
    });
    expect(nativeRow.amount).toBe("0.5");
  });

  it("refuses a leg whose quote does not split, credits nothing, or has no single owner", async () => {
    const row = await recordQuotedTransfer(
      db(),
      tenant,
      transferInput("xfr_leg_checks"),
      nativeQuote("1", "debit")
    );
    const insert = (
      owner: [string | null, string | null],
      debit: number,
      fee: number,
      credit: number
    ) =>
      db().execute(
        `INSERT INTO token_movement_legs (id, organization_id, project_id, payment_transfer_id,
           payment_transfer_recipient_id, asset_kind, decimals, basis, quoted_debit, quoted_fee,
           quoted_credit)
         VALUES (?, ?, ?, ?, ?, 'native', 9, 'debit', ?, ?, ?)`,
        [`tml_check_${debit}_${credit}`, TEST_ORG.id, PROJECT_ID, ...owner, debit, fee, credit]
      );

    await expect(insert([null, null], 2, 0, 2)).rejects.toThrow(/one_owner/);
    await expect(insert([row.id, null], 3, 0, 1)).rejects.toThrow(/quote_splits/);
    await expect(insert([row.id, null], 0, 0, 0)).rejects.toThrow(/quote_credits/);
  });

  it("replaces a quote only until the movement's signature is saved", async () => {
    const row = await recordQuotedTransfer(
      db(),
      tenant,
      transferInput("xfr_leg_sealed"),
      nativeQuote("1", "debit")
    );
    const owner = { kind: "transfer", transferId: row.id } as const;

    const requoted = await legs().upsertTransferLeg({ owner, quote: nativeQuote("2", "debit") });
    expect(requoted?.quoted.debit).toBe(2_000_000_000n);

    await payments().persistSignedTransfer({
      transferId: row.id,
      organizationId: TEST_ORG.id,
      projectId: PROJECT_ID,
      signature: "sig_leg_sealed",
      signedTransaction: "AQ==",
      lastValidBlockHeight: "1000",
      updatedAt: new Date().toISOString(),
    });

    await expect(
      legs().upsertTransferLeg({ owner, quote: nativeQuote("3", "debit") })
    ).resolves.toBeNull();
    await expect(
      db().execute(
        "UPDATE token_movement_legs SET quoted_debit = 5, quoted_credit = 5 WHERE payment_transfer_id = ?",
        [row.id]
      )
    ).rejects.toThrow(/sealed/);
    await expect(
      db().execute(
        "UPDATE token_movement_legs SET observed_debit = 2000000000, observed_fee = 0, observed_credit = 2000000000 WHERE payment_transfer_id = ?",
        [row.id]
      )
    ).resolves.toBe(1);
    expect((await legs().listLegsByTransfers([row.id])).get(row.id)?.[0]?.quoted.debit).toBe(
      2_000_000_000n
    );
  });

  it("verifies a transfer's leg when it confirms, and marks a failed one not executed", async () => {
    const confirmed = await recordQuotedTransfer(
      db(),
      tenant,
      transferInput("xfr_leg_confirmed"),
      nativeQuote("1", "debit")
    );
    const failed = await recordQuotedTransfer(
      db(),
      tenant,
      transferInput("xfr_leg_failed"),
      nativeQuote("1", "debit")
    );
    const update = (transferId: string, status: "confirmed" | "failed") =>
      payments().updateTransfer({
        transferId,
        organizationId: TEST_ORG.id,
        projectId: PROJECT_ID,
        expectedStatus: "processing",
        status,
        updatedAt: new Date().toISOString(),
      });

    await update(confirmed.id, "confirmed");
    await update(failed.id, "failed");

    const byTransfer = await legs().listLegsByTransfers([confirmed.id, failed.id]);
    expect(byTransfer.get(confirmed.id)?.[0]?.verification).toEqual({
      state: "verified",
      reason: "sdp_built_transfer_landed",
    });
    expect(byTransfer.get(failed.id)?.[0]?.verification).toEqual({
      state: "not_required",
      reason: "movement_not_executed",
    });
  });

  it("claims an off-ramp deposit with its credit leg, verified once the deposit lands", async () => {
    const created = await createPostgresPaymentsRepository(db(), tenant).createTransfer({
      ...transferInput("xfr_leg_offramp"),
      amount: "0.995",
      destinationAddress: null,
      type: "offramp",
      status: "awaiting_payment",
      provider: "moonpay",
      providerData: { cryptoDeposit: { destinationAddress: "Deposit111", amount: "0.995" } },
    });
    if (created === null) throw new Error("Expected the off-ramp row");
    const quote = tokenQuote(mintTerms([transferFeeExtension(50, 5_000n)]), "0.995", "credit");
    const claim = {
      transferId: created.id,
      organizationId: TEST_ORG.id,
      projectId: PROJECT_ID,
      custodyWalletId: CUSTODY_WALLET_ID,
      walletId: WALLET_ID,
      sourceAddress: "Source111",
      destinationAddress: "Deposit111",
      token: MINT,
      initiatedByKeyId: "key_leg_offramp",
      idempotency: null,
      updatedAt: new Date().toISOString(),
    };

    const claimed = await claimOfframpDepositWithLeg(db(), tenant, claim, quote);
    expect(claimed).toMatchObject({ status: "processing", amount: "0.995" });

    await payments().transitionRampTransfer({
      transferId: created.id,
      organizationId: TEST_ORG.id,
      projectId: PROJECT_ID,
      transition: "offramp_deposit_confirmed",
      updatedAt: new Date().toISOString(),
    });
    const [leg] = (await legs().listLegsByTransfers([created.id])).get(created.id) ?? [];
    expect(leg).toMatchObject({
      basis: "credit",
      quoted: { debit: 1_000_000n, fee: 5_000n, credit: 995_000n },
      verification: { state: "verified", reason: "sdp_built_transfer_landed" },
    });
  });

  it("writes a leg per batch recipient and settles them with their chunk", async () => {
    await seedProjectCryptoWalletCounterparty(db(), {
      organizationId: TEST_ORG.id,
      projectId: PROJECT_ID,
      createdBy: TEST_USER.id,
      counterpartyId: "cpty_legs",
      counterpartyAccountId: "cpacct_legs",
      walletAddress: "Dest111",
    });
    const batches = createPostgresPaymentTransferBatchesRepository(db());
    const recipient = (amount: string) => ({
      organizationId: TEST_ORG.id,
      projectId: PROJECT_ID,
      externalId: null,
      counterpartyId: "cpty_legs",
      counterpartyAccountId: "cpacct_legs",
      destinationAddress: "Dest111",
      quote: nativeQuote(amount, "debit"),
      status: "pending" as const,
      error: null,
    });
    const { batch, recipients } = await batches.createTransferBatchWithRecipients({
      batch: {
        organizationId: TEST_ORG.id,
        projectId: PROJECT_ID,
        sourceCustodyWalletId: CUSTODY_WALLET_ID,
        sourceWalletId: WALLET_ID,
        sourceAddress: "Source111",
        token: SOL_MINT,
        status: "processing",
        recipientCount: 2,
        transactionCount: 1,
      },
      recipients: [recipient("1.25"), recipient("0.75")],
    });
    expect(batch.total_amount).toBe("2");
    expect(recipients.map((row) => row.amount)).toEqual(["1.25", "0.75"]);

    const chunk = await createPostgresPaymentsRepository(db(), tenant).createTransfer({
      ...transferInput("xfr_leg_chunk"),
      amount: "2",
      type: "transfer_batch",
    });
    if (chunk === null) throw new Error("Expected the chunk row");
    await batches.updateTransferRecipientsStatus({
      recipientIds: recipients.map((row) => row.id),
      organizationId: TEST_ORG.id,
      projectId: PROJECT_ID,
      transferId: chunk.id,
      status: "processing",
      error: null,
    });
    await batches.settleTransferBatch({
      transferId: chunk.id,
      organizationId: TEST_ORG.id,
      projectId: PROJECT_ID,
      transferStatus: "confirmed",
      error: null,
      slot: 10,
      updatedAt: new Date().toISOString(),
    });

    const chunkLegs = (await legs().listLegsByTransfers([chunk.id])).get(chunk.id) ?? [];
    expect(chunkLegs.map((leg) => leg.verification.state)).toEqual(["verified", "verified"]);
    const totals = await legs().sumLegsByBatches([batch.id]);
    expect(totals.get(batch.id)).toEqual({
      basis: "debit",
      decimals: 9,
      debit: 2_000_000_000n,
      fee: 0n,
      credit: 2_000_000_000n,
    });
  });

  /** A two-recipient native SOL batch whose recipients each have a leg. */
  async function recipientBatch() {
    await seedProjectCryptoWalletCounterparty(db(), {
      organizationId: TEST_ORG.id,
      projectId: PROJECT_ID,
      createdBy: TEST_USER.id,
      counterpartyId: "cpty_legs",
      counterpartyAccountId: "cpacct_legs",
      walletAddress: "Dest111",
    });
    const batches = createPostgresPaymentTransferBatchesRepository(db());
    const recipient = (amount: string) => ({
      organizationId: TEST_ORG.id,
      projectId: PROJECT_ID,
      externalId: null,
      counterpartyId: "cpty_legs",
      counterpartyAccountId: "cpacct_legs",
      destinationAddress: "Dest111",
      quote: nativeQuote(amount, "debit"),
      status: "pending" as const,
      error: null,
    });
    const { recipients } = await batches.createTransferBatchWithRecipients({
      batch: {
        organizationId: TEST_ORG.id,
        projectId: PROJECT_ID,
        sourceCustodyWalletId: CUSTODY_WALLET_ID,
        sourceWalletId: WALLET_ID,
        sourceAddress: "Source111",
        token: SOL_MINT,
        status: "processing",
        recipientCount: 2,
        transactionCount: 1,
      },
      recipients: [recipient("1.25"), recipient("0.75")],
    });
    return { batches, recipientIds: recipients.map((row) => row.id) };
  }

  it("fails recipients no chunk carried together with their legs", async () => {
    const { batches, recipientIds } = await recipientBatch();

    const failed = await batches.updateTransferRecipientsStatus({
      recipientIds,
      organizationId: TEST_ORG.id,
      projectId: PROJECT_ID,
      transferId: null,
      status: "failed",
      error: "Simulation failed",
    });

    expect(failed.map((row) => row.status)).toEqual(["failed", "failed"]);
    const byRecipient = await legs().listLegsByRecipients(recipientIds);
    expect(recipientIds.map((id) => required(byRecipient.get(id)).verification)).toEqual([
      { state: "not_required", reason: "movement_not_executed" },
      { state: "not_required", reason: "movement_not_executed" },
    ]);
  });

  it("archives a recipient's leg with it", async () => {
    const { batches, recipientIds } = await recipientBatch();
    const [archivedId, keptId] = recipientIds;

    const archived = await batches.deleteTransferRecipient({
      recipientId: archivedId,
      organizationId: TEST_ORG.id,
      projectId: PROJECT_ID,
    });

    expect(required(archived).status).toBe("archived");
    const byRecipient = await legs().listLegsByRecipients(recipientIds);
    expect([...byRecipient.keys()]).toEqual([keptId]);
    const statuses = await db()
      .prepare(
        "SELECT payment_transfer_recipient_id AS id, status FROM token_movement_legs WHERE payment_transfer_recipient_id = ANY(?::text[]) ORDER BY status"
      )
      .bind(recipientIds)
      .all<{ id: string; status: string }>();
    expect(statuses.results).toEqual([
      { id: keptId, status: "active" },
      { id: archivedId, status: "archived" },
    ]);
  });

  it("reads no leg of another project's transfer", async () => {
    const row = await recordQuotedTransfer(
      db(),
      tenant,
      transferInput("xfr_leg_scoped"),
      nativeQuote("1", "debit")
    );

    const other = createPostgresTokenMovementLegsRepository(db(), otherTenant);
    expect((await other.listLegsByTransfers([row.id])).size).toBe(0);
    expect((await legs().listLegsByTransfers([row.id])).get(row.id)).toHaveLength(1);
  });

  it("never writes a chain verdict or a settlement on an archived leg", async () => {
    const quote = tokenQuote(mintTerms([]), "25", "debit");
    const transfer = required(
      await payments().createTransfer({ ...transferInput("xfr_leg_archived_chain"), amount: "25" })
    );
    const leg = await legs().insertChainLeg({
      owner: { kind: "transfer", transferId: transfer.id },
      quote,
    });
    await db()
      .prepare("UPDATE token_movement_legs SET status = 'archived' WHERE id = ?")
      .bind(leg.id)
      .run();

    expect(
      await legs().recordChainVerdict({
        transferId: transfer.id,
        observed: { debit: quote.debit, fee: quote.fee, credit: quote.credit },
        updatedAt: new Date().toISOString(),
      })
    ).toBeNull();
    expect(
      await legs().settlePendingTransferLeg({
        transferId: transfer.id,
        verdict: { state: "not_required", reason: "movement_not_executed" },
        updatedAt: new Date().toISOString(),
      })
    ).toBe(false);
  });

  it("rolls the transfer back when its leg cannot be written", async () => {
    // A 1-base-unit debit at 50 bps pays its whole amount in fee, which the leg refuses.
    const nothingCredited = tokenQuote(
      mintTerms([transferFeeExtension(50, 5_000n)]),
      "0.000001",
      "debit"
    );
    expect(nothingCredited.credit).toBe(0n);

    await expect(
      recordQuotedTransfer(db(), tenant, transferInput("xfr_leg_rollback"), nothingCredited)
    ).rejects.toThrow(/quote_credits/);
    expect(
      await payments().getTransferById({
        transferId: "xfr_leg_rollback",
        organizationId: TEST_ORG.id,
        projectId: PROJECT_ID,
      })
    ).toBeNull();
  });
});
