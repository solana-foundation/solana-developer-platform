import { readBvnkOnrampTransferData } from "@sdp/payments/ramps/providers/bvnk/provider-data";
import {
  buildCompleteSettlement,
  bvnkPayoutObservationFromSource,
} from "@sdp/payments/ramps/providers/bvnk/settlement";
import { afterAll, assert, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import {
  bvnkPayoutSummary,
  bvnkProcessingSettlement,
  type SeedBvnkOnrampPayin,
  seedBvnkOnrampCounterpartyAndFundingWallet,
  seedBvnkOnrampPayinApplied,
  seedBvnkOnrampPayoutClaimed,
  seedBvnkOnrampPayoutIssued,
  seedBvnkOnrampTransfer,
} from "@/test/helpers/bvnk";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import type { BvnkOnrampTransfersRepository } from "./bvnk-onramp-transfers.repository";
import { createPostgresBvnkOnrampTransfersRepository } from "./bvnk-onramp-transfers.repository.postgres";

const TEST_PROJECT_ID = "prj_bvnk_onramp_test";
const TEST_PRODUCTION_PROJECT_ID = `${TEST_PROJECT_ID}_production`;

const SANDBOX = "sandbox" as const;
const PRODUCTION = "production" as const;

/** A codec-valid pay-in blob; the walletId mirrors the seeded funding wallet reference. */
function makePayin(id: string, walletId: string): SeedBvnkOnrampPayin {
  return {
    id,
    receivedAmount: "100.00",
    receivedCurrency: "USD",
    walletId,
    customerId: `cust_${id}`,
  };
}

/** A codec-valid spend intent, unique per destination so claims never look like replay. */
function makeIntent(address: string) {
  return {
    amount: "99.90",
    currency: "USD",
    cryptoCurrency: "USDC",
    network: "SOLANA",
    address,
  } as const;
}

/** A schema-valid COMPLETE settlement built from the fixture summary observations. */
function completeSettlement(transferId: string, payoutId: string) {
  const parsed = bvnkPayoutObservationFromSource(
    bvnkPayoutSummary({
      uuid: payoutId,
      reference: transferId,
      status: "COMPLETED",
      walletCurrency: { currency: "USD", amount: 100, actual: 99.9 },
      paidCurrency: { currency: "USDC", amount: 99.9, actual: 99.9 },
      feeCurrency: { currency: "USD", amount: 0.1, actual: 0.1 },
      transactions: [{ hash: `tx_${payoutId}` }],
      address: { address: `Addr${payoutId}`, network: "SOLANA" },
    })
  );
  if (!parsed.ok || parsed.observation.outcome !== "completed") {
    throw new Error("completeSettlement requires a COMPLETED summary");
  }
  return buildCompleteSettlement(
    bvnkProcessingSettlement(transferId, payoutId),
    parsed.observation
  );
}

const seedScope = (name: string, fundingWalletReference: string) => ({
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT_ID,
  name,
  createdBy: TEST_USER.id,
  fundingWalletReference,
});

describe("BvnkOnrampTransfersRepository (postgres)", () => {
  let repo: BvnkOnrampTransfersRepository;

  beforeAll(async () => {
    await seedTestDatabase(env);
  });

  afterAll(async () => {
    await seedTestDatabase(env);
  });

  beforeEach(async () => {
    const db = getDb(env);
    await db.prepare("DELETE FROM payment_transfers").run();
    await db.prepare("DELETE FROM counterparty_provider_accounts").run();
    await db.prepare("DELETE FROM counterparties").run();
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
      ids: { sandbox: TEST_PROJECT_ID, production: TEST_PRODUCTION_PROJECT_ID },
    });
    repo = createPostgresBvnkOnrampTransfersRepository(db);
  });

  /** Pins the candidate-ordering clock so ORDER BY updated_at ASC is deterministic. */
  async function setUpdatedAt(transferId: string, updatedAt: string): Promise<void> {
    await getDb(env)
      .prepare("UPDATE payment_transfers SET updated_at = ? WHERE id = ?")
      .bind(updatedAt, transferId)
      .run();
  }

  it("applyPayin_persists_atomically_and_enforces_wallet_fiat_bindings", async () => {
    const db = getDb(env);
    const { counterpartyId, fundingReference } = await seedBvnkOnrampCounterpartyAndFundingWallet(
      db,
      seedScope("apply", "a:wallet:apply:1")
    );
    const seed = (id: string) =>
      seedBvnkOnrampTransfer(db, {
        id,
        status: "awaiting_payment",
        counterpartyId,
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        fiatAmount: "100.00",
        destinationAddress: "AddrApply",
      });
    const call = (
      transferId: string,
      receivedAmount: string,
      receivedCurrency: string,
      walletReference: string = fundingReference
    ) =>
      repo.applyPayin({
        transferId,
        fundingWalletReference: walletReference,
        payin: {
          ...makePayin(`payin_${transferId}`, fundingReference),
          receivedAmount,
          receivedCurrency,
        },
      });

    // Happy atomics: one UPDATE lands status, fiat, and the nested pay-in;
    // the replay is refused and the persisted blob survives a re-read.
    await seed("xfr_apply_happy");
    const payin = makePayin("payin_apply_happy", fundingReference);
    const applied = await repo.applyPayin({
      transferId: "xfr_apply_happy",
      fundingWalletReference: fundingReference,
      payin,
    });
    assert(applied);
    expect(applied.status).toBe("settling");
    expect(applied.fiat_amount).toBe("100.00");
    expect(applied.fiat_currency).toBe("USD");
    expect((applied.provider_data.bvnk as { payin: SeedBvnkOnrampPayin }).payin).toEqual(payin);
    expect(
      await repo.applyPayin({
        transferId: "xfr_apply_happy",
        fundingWalletReference: fundingReference,
        payin,
      })
    ).toBeNull();
    const current = await repo.getById({ transferId: "xfr_apply_happy", environment: SANDBOX });
    assert(current);
    expect((current.provider_data.bvnk as { payin: SeedBvnkOnrampPayin }).payin).toEqual(payin);

    // Received-currency, wallet-reference, and funding-wallet fiat mismatches
    // never bind, leaving the row untouched.
    await seed("xfr_apply_wrong_currency");
    expect(await call("xfr_apply_wrong_currency", "100.00", "EUR")).toBeNull();
    await seed("xfr_apply_wrong_wallet");
    expect(
      await call("xfr_apply_wrong_wallet", "100.00", "USD", "a:wallet:some_other_wallet:1")
    ).toBeNull();
    await seed("xfr_apply_wrong_fiat_wallet");
    await db
      .prepare(
        "UPDATE counterparty_provider_accounts SET fiat_currency = 'EUR' WHERE external_account_reference = ?"
      )
      .bind(fundingReference)
      .run();
    expect(await call("xfr_apply_wrong_fiat_wallet", "100.00", "USD")).toBeNull();
    for (const id of [
      "xfr_apply_wrong_currency",
      "xfr_apply_wrong_wallet",
      "xfr_apply_wrong_fiat_wallet",
    ]) {
      expect((await repo.getById({ transferId: id, environment: SANDBOX }))?.status).toBe(
        "awaiting_payment"
      );
    }

    // Non-positive and malformed amounts throw before any write.
    for (const [id, amount] of [
      ["xfr_apply_zero", "0"],
      ["xfr_apply_negative", "-5.00"],
      ["xfr_apply_malformed", "12.34.56"],
      ["xfr_apply_blank", "  "],
    ] as const) {
      await seed(id);
      await expect(call(id, amount, "USD")).rejects.toThrow(/positive decimal amount/);
    }
  });

  it("claimPayout_and_leasePayoutRecovery_are_guarded", async () => {
    await seedBvnkOnrampPayinApplied(getDb(env), {
      ...seedScope("lease_recovery", "a:wallet:lease_recovery:1"),
      transferId: "xfr_lease_recovery",
      destinationAddress: "AddrLease",
      payin: makePayin("payin_lease", "a:wallet:lease_recovery:1"),
    });

    // The claim slot is first-write-wins and persists the intent verbatim.
    const intent = makeIntent("AddrLease");
    const claimed = await repo.claimPayout({
      transferId: "xfr_lease_recovery",
      claimedAt: "2026-09-18T00:01:00.000Z",
      intent,
    });
    assert(claimed);
    const bvnk = claimed.provider_data.bvnk as {
      payout: { claimedAt: string; attempts: number; intent: typeof intent };
    };
    expect(bvnk.payout).toEqual({ claimedAt: "2026-09-18T00:01:00.000Z", attempts: 1, intent });
    expect(
      await repo.claimPayout({
        transferId: "xfr_lease_recovery",
        claimedAt: "2026-09-18T00:02:00.000Z",
        intent: { ...intent, amount: "1.00" },
      })
    ).toBeNull();

    const leased = await repo.leasePayoutRecovery({
      transferId: "xfr_lease_recovery",
      observedClaimedAt: "2026-09-18T00:01:00.000Z",
      claimedAt: "2026-09-18T00:31:00.000Z",
    });
    assert(leased);
    const leasedPayout = leased.provider_data.bvnk as {
      payout: { claimedAt: string; attempts: number; intent: { amount: string } };
    };
    expect(leasedPayout.payout.claimedAt).toBe("2026-09-18T00:31:00.000Z");
    expect(leasedPayout.payout.attempts).toBe(2);
    expect(leasedPayout.payout.intent.amount).toBe("99.90");

    expect(
      await repo.leasePayoutRecovery({
        transferId: "xfr_lease_recovery",
        observedClaimedAt: "2026-09-18T00:01:00.000Z",
        claimedAt: "2026-09-18T00:32:00.000Z",
      })
    ).toBeNull();

    await repo.recordPayoutId({
      transferId: "xfr_lease_recovery",
      payoutId: "payout_lease_1",
      claimedAt: "2026-09-18T00:31:00.000Z",
      environment: SANDBOX,
      settlement: bvnkProcessingSettlement("xfr_lease_recovery", "payout_lease_1"),
    });
    expect(
      await repo.leasePayoutRecovery({
        transferId: "xfr_lease_recovery",
        observedClaimedAt: "2026-09-18T00:31:00.000Z",
        claimedAt: "2026-09-18T00:33:00.000Z",
      })
    ).toBeNull();
  });

  it("recordPayoutId_replays_same_id_throws_on_divergence_and_vanished_rows", async () => {
    await seedBvnkOnrampPayoutClaimed(getDb(env), {
      ...seedScope("record_divergence", "a:wallet:record_divergence:1"),
      transferId: "xfr_record_divergence",
      destinationAddress: "AddrRecord",
      payin: makePayin("payin_record_divergence", "a:wallet:record_divergence:1"),
      claimedAt: "2026-09-18T00:01:00.000Z",
      intent: makeIntent("AddrRecord"),
    });
    const first = await repo.recordPayoutId({
      transferId: "xfr_record_divergence",
      payoutId: "payout_record_1",
      claimedAt: "2026-09-18T00:01:00.000Z",
      environment: SANDBOX,
      settlement: bvnkProcessingSettlement("xfr_record_divergence", "payout_record_1"),
    });
    assert(first);
    const replay = await repo.recordPayoutId({
      transferId: "xfr_record_divergence",
      payoutId: "payout_record_1",
      claimedAt: "2026-09-18T00:01:00.000Z",
      environment: SANDBOX,
      settlement: bvnkProcessingSettlement("xfr_record_divergence", "payout_record_1"),
    });
    expect(replay).toMatchObject({ id: "xfr_record_divergence" });
    await expect(
      repo.recordPayoutId({
        transferId: "xfr_record_divergence",
        payoutId: "payout_record_other",
        claimedAt: "2026-09-18T00:01:00.000Z",
        environment: SANDBOX,
        settlement: bvnkProcessingSettlement("xfr_record_divergence", "payout_record_other"),
      })
    ).rejects.toThrow(/diverged/);

    await seedBvnkOnrampPayoutClaimed(getDb(env), {
      ...seedScope("record_vanished", "a:wallet:record_vanished:1"),
      transferId: "xfr_record_vanished",
      destinationAddress: "AddrRecordVanished",
      payin: makePayin("payin_record_vanished", "a:wallet:record_vanished:1"),
      claimedAt: "2026-09-18T00:01:00.000Z",
      intent: makeIntent("AddrRecordVanished"),
    });
    await getDb(env)
      .prepare("DELETE FROM payment_transfers WHERE id = ?")
      .bind("xfr_record_vanished")
      .run();
    await expect(
      repo.recordPayoutId({
        transferId: "xfr_record_vanished",
        payoutId: "payout_vanished_1",
        claimedAt: "2026-09-18T00:01:00.000Z",
        environment: SANDBOX,
        settlement: bvnkProcessingSettlement("xfr_record_vanished", "payout_vanished_1"),
      })
    ).rejects.toThrow(/vanished/);
  });

  it("failPayout_guards_first_attempts_and_payout_ids", async () => {
    // The first-attempt fail; the failed row can never later record a payout id.
    await seedBvnkOnrampPayoutClaimed(getDb(env), {
      ...seedScope("fail_first_attempt", "a:wallet:fail_first_attempt:1"),
      transferId: "xfr_fail_first_attempt",
      destinationAddress: "AddrFailFirst",
      payin: makePayin("payin_fail_first", "a:wallet:fail_first_attempt:1"),
      claimedAt: "2026-09-18T00:01:00.000Z",
      intent: makeIntent("AddrFailFirst"),
    });
    const failed = await repo.failPayout({
      transferId: "xfr_fail_first_attempt",
      payoutId: null,
      error: "MER-PAY-2012",
      claimedAt: "2026-09-18T00:01:00.000Z",
    });
    assert(failed);
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("MER-PAY-2012");
    expect((failed.provider_data.bvnk as { payout: { lastError: string } }).payout.lastError).toBe(
      "MER-PAY-2012"
    );
    await expect(
      repo.recordPayoutId({
        transferId: "xfr_fail_first_attempt",
        payoutId: "payout_after_fail",
        claimedAt: "2026-09-18T00:01:00.000Z",
        environment: SANDBOX,
        settlement: bvnkProcessingSettlement("xfr_fail_first_attempt", "payout_after_fail"),
      })
    ).rejects.toThrow(/diverged/);

    // A leased (attempts = 2) claim refuses the payoutId-less fail: recovery owns retries.
    await seedBvnkOnrampPayoutClaimed(getDb(env), {
      ...seedScope("fail_recovery", "a:wallet:fail_recovery:1"),
      transferId: "xfr_fail_recovery",
      destinationAddress: "AddrFailRecovery",
      payin: makePayin("payin_fail_recovery", "a:wallet:fail_recovery:1"),
      claimedAt: "2026-09-18T00:01:00.000Z",
      intent: makeIntent("AddrFailRecovery"),
    });
    await repo.leasePayoutRecovery({
      transferId: "xfr_fail_recovery",
      observedClaimedAt: "2026-09-18T00:01:00.000Z",
      claimedAt: "2026-09-18T00:31:00.000Z",
    });
    expect(
      await repo.failPayout({
        transferId: "xfr_fail_recovery",
        payoutId: null,
        error: "MER-PAY-2012",
        claimedAt: "2026-09-18T00:31:00.000Z",
      })
    ).toBeNull();
    expect(
      (await repo.getById({ transferId: "xfr_fail_recovery", environment: SANDBOX }))?.status
    ).toBe("settling");

    // A payout-id fail is fenced on the id AND the held claim.
    await seedBvnkOnrampPayoutIssued(getDb(env), {
      ...seedScope("fail_with_id", "a:wallet:fail_with_id:1"),
      transferId: "xfr_fail_with_id",
      destinationAddress: "AddrFailId",
      payin: makePayin("payin_fail_with_id", "a:wallet:fail_with_id:1"),
      claimedAt: "2026-09-18T00:01:00.000Z",
      intent: makeIntent("AddrFailId"),
      environment: SANDBOX,
      payoutId: "payout_fail_id_1",
    });
    expect(
      await repo.failPayout({
        transferId: "xfr_fail_with_id",
        payoutId: "payout_fail_id_wrong",
        error: "MER-PAY-2011",
        claimedAt: "2026-09-18T00:01:00.000Z",
      })
    ).toBeNull();
    expect(
      await repo.failPayout({
        transferId: "xfr_fail_with_id",
        payoutId: "payout_fail_id_1",
        error: "MER-PAY-2011",
        claimedAt: "2026-09-18T00:02:00.000Z",
      })
    ).toBeNull();
    const failedWithId = await repo.failPayout({
      transferId: "xfr_fail_with_id",
      payoutId: "payout_fail_id_1",
      error: "MER-PAY-2011",
      claimedAt: "2026-09-18T00:01:00.000Z",
    });
    assert(failedWithId);
    expect(failedWithId.status).toBe("failed");
    expect(failedWithId.error).toBe("MER-PAY-2011");
  });

  it("failPayoutUnclaimed_fails_an_unclaimed_row_and_refuses_a_claimed_one", async () => {
    const fundingWalletReference = "a:wallet:fail_unclaimed:1";
    await seedBvnkOnrampPayinApplied(getDb(env), {
      ...seedScope("fail_unclaimed", fundingWalletReference),
      transferId: "xfr_fail_unclaimed",
      destinationAddress: "AddrFailUnclaimed",
      payin: makePayin("payin_fail_unclaimed", fundingWalletReference),
    });
    const failed = await repo.failPayoutUnclaimed({
      transferId: "xfr_fail_unclaimed",
      error: "MER-PAY-2012",
      claimedAt: "2026-09-18T00:01:00.000Z",
    });
    assert(failed);
    expect(failed.status).toBe("failed");
    const payout = (
      failed.provider_data.bvnk as {
        payout: { claimedAt: string; attempts: number; lastError: string };
      }
    ).payout;
    expect(payout).toEqual({
      claimedAt: "2026-09-18T00:01:00.000Z",
      attempts: 1,
      lastError: "MER-PAY-2012",
    });
    const parsed = readBvnkOnrampTransferData(failed.provider_data);
    expect(parsed.payout?.intent).toBeUndefined();
    expect(parsed.payout?.payoutId).toBeUndefined();
    expect(parsed.payin).toEqual(makePayin("payin_fail_unclaimed", fundingWalletReference));

    await seedBvnkOnrampPayoutClaimed(getDb(env), {
      ...seedScope("fail_unclaimed_refused", "a:wallet:fail_unclaimed_refused:1"),
      transferId: "xfr_fail_unclaimed_refused",
      destinationAddress: "AddrFailUnclaimedRefused",
      payin: makePayin("payin_fail_unclaimed_refused", "a:wallet:fail_unclaimed_refused:1"),
      claimedAt: "2026-09-18T00:01:00.000Z",
      intent: makeIntent("AddrFailUnclaimedRefused"),
    });
    expect(
      await repo.failPayoutUnclaimed({
        transferId: "xfr_fail_unclaimed_refused",
        error: "MER-PAY-2012",
        claimedAt: "2026-09-18T00:02:00.000Z",
      })
    ).toBeNull();
    const current = await repo.getById({
      transferId: "xfr_fail_unclaimed_refused",
      environment: SANDBOX,
    });
    expect(current?.status).toBe("settling");
    if (current !== null) {
      const claim = (current.provider_data.bvnk as { payout: { claimedAt: string } }).payout;
      expect(claim.claimedAt).toBe("2026-09-18T00:01:00.000Z");
    }
  });

  it("settlePayout_guarded_on_payout_id_and_claim", async () => {
    await seedBvnkOnrampPayoutIssued(getDb(env), {
      ...seedScope("settle_guard", "a:wallet:settle_guard:1"),
      transferId: "xfr_settle_guard",
      destinationAddress: "AddrSettle",
      payin: makePayin("payin_settle", "a:wallet:settle_guard:1"),
      claimedAt: "2026-09-18T00:01:00.000Z",
      intent: makeIntent("AddrSettle"),
      environment: SANDBOX,
      payoutId: "payout_settle_1",
    });
    const settledBlob = completeSettlement("xfr_settle_guard", "payout_settle_1");
    const update = {
      signature: `tx_payout_settle_1`,
      destinationAddress: "AddrSettle",
      amount: "0.99",
      settlement: settledBlob,
    };
    expect(
      await repo.settlePayout({
        transferId: "xfr_settle_guard",
        payoutId: "payout_settle_wrong",
        claimedAt: "2026-09-18T00:01:00.000Z",
        update,
      })
    ).toBeNull();
    expect(
      await repo.settlePayout({
        transferId: "xfr_settle_guard",
        payoutId: "payout_settle_1",
        claimedAt: "2026-09-18T00:02:00.000Z",
        update,
      })
    ).toBeNull();

    const settled = await repo.settlePayout({
      transferId: "xfr_settle_guard",
      payoutId: "payout_settle_1",
      claimedAt: "2026-09-18T00:01:00.000Z",
      update,
    });
    assert(settled);
    expect(settled.status).toBe("completed");
    expect(settled.signature).toBe(`tx_payout_settle_1`);
    expect(settled.destination_address).toBe("AddrSettle");
    expect(settled.amount).toBe("0.99");
    expect(settled.provider_data.settlement).toEqual(settledBlob);
  });

  it("listPollablePayoutCandidates_rotates_claims_and_polls_before_limit", async () => {
    const db = getDb(env);
    const fundingWalletReference = "a:wallet:list_pollable:1";
    const seedIssued = (transferId: string, name: string, payoutId: string) =>
      seedBvnkOnrampPayoutIssued(db, {
        ...seedScope(name, fundingWalletReference),
        transferId,
        destinationAddress: "AddrListPollable",
        payin: makePayin(`payin_${name}`, fundingWalletReference),
        claimedAt: "2026-09-18T00:00:00.000Z",
        intent: makeIntent(`AddrListPollable${name}`),
        environment: SANDBOX,
        payoutId,
      });
    await seedIssued("xfr_pollable_never_polled", "pollable_never", "payout_pollable_1");
    await seedIssued("xfr_pollable_stale_poll", "pollable_stale", "payout_pollable_2");
    await seedIssued("xfr_pollable_fresh_poll", "pollable_fresh", "payout_pollable_3");
    await seedBvnkOnrampPayoutClaimed(db, {
      ...seedScope("pollable_no_id", fundingWalletReference),
      transferId: "xfr_pollable_no_id",
      destinationAddress: "AddrListPollable",
      payin: makePayin("payin_pollable_no_id", fundingWalletReference),
      claimedAt: "2026-09-18T00:00:00.000Z",
      intent: makeIntent("AddrListPollableNoId"),
    });
    await repo.markPayoutPolled({
      transferId: "xfr_pollable_stale_poll",
      polledAt: "2026-09-18T00:30:00.000Z",
    });
    await repo.markPayoutPolled({
      transferId: "xfr_pollable_fresh_poll",
      polledAt: "2026-09-18T02:00:00.000Z",
    });
    await setUpdatedAt("xfr_pollable_never_polled", "2026-09-18T00:00:00.000Z");
    await setUpdatedAt("xfr_pollable_stale_poll", "2026-09-18T00:00:10.000Z");
    await setUpdatedAt("xfr_pollable_fresh_poll", "2026-09-18T00:00:20.000Z");
    await setUpdatedAt("xfr_pollable_no_id", "2026-09-18T00:00:30.000Z");

    const rows = await repo.listPollablePayoutCandidates({
      limit: 10,
      cutoff: "2026-09-18T01:00:00.000Z",
    });
    expect(rows.map((row) => row.id)).toEqual([
      "xfr_pollable_never_polled",
      "xfr_pollable_stale_poll",
    ]);
    expect(rows.every((row) => row.fundingWalletReference === fundingWalletReference)).toBe(true);
    // Poll rotation: a cutoff between the claims and their polls clears the
    // polled rows (their lastPolledAt already advanced past it).
    const rotated = await repo.listPollablePayoutCandidates({
      limit: 10,
      cutoff: "2026-09-18T00:15:00.000Z",
    });
    expect(rotated.map((row) => row.id)).toEqual(["xfr_pollable_never_polled"]);
  });

  it("getByPayinId_and_getById_isolate_projects_by_environment", async () => {
    const db = getDb(env);
    await seedBvnkOnrampPayinApplied(db, {
      ...seedScope("env_sandbox", "a:wallet:env_sandbox:1"),
      projectId: TEST_PROJECT_ID,
      transferId: "xfr_env_sandbox",
      destinationAddress: "AddrEnvSandbox",
      payin: makePayin("payin_env_sandbox", "a:wallet:env_sandbox:1"),
    });
    await seedBvnkOnrampPayinApplied(db, {
      ...seedScope("env_production", "a:wallet:env_production:1"),
      projectId: TEST_PRODUCTION_PROJECT_ID,
      transferId: "xfr_env_production",
      destinationAddress: "AddrEnvProduction",
      payin: makePayin("payin_env_production", "a:wallet:env_production:1"),
    });

    const sandboxByPayin = await repo.getByPayinId({
      payinId: "payin_env_sandbox",
      environment: SANDBOX,
    });
    expect(sandboxByPayin?.id).toBe("xfr_env_sandbox");
    expect(sandboxByPayin?.project_id).toBe(TEST_PROJECT_ID);
    expect(
      await repo.getByPayinId({ payinId: "payin_env_sandbox", environment: PRODUCTION })
    ).toBeNull();

    const productionByPayin = await repo.getByPayinId({
      payinId: "payin_env_production",
      environment: PRODUCTION,
    });
    expect(productionByPayin?.id).toBe("xfr_env_production");
    expect(productionByPayin?.project_id).toBe(TEST_PRODUCTION_PROJECT_ID);
    const productionById = await repo.getById({
      transferId: "xfr_env_production",
      environment: PRODUCTION,
    });
    expect(productionById?.project_id).toBe(TEST_PRODUCTION_PROJECT_ID);
    expect(
      await repo.getById({ transferId: "xfr_env_production", environment: SANDBOX })
    ).toBeNull();
    expect(
      await repo.getByPayinId({ payinId: "payin_env_missing", environment: SANDBOX })
    ).toBeNull();
  });
});
