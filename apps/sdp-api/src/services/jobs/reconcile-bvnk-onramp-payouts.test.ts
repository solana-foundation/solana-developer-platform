import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import { BvnkPayRequestError } from "@sdp/payments/ramps/providers/bvnk/client";
import {
  BVNK_PAYOUT_NETWORK,
  readBvnkOnrampTransferData,
} from "@sdp/payments/ramps/providers/bvnk/provider-data";
import type {
  BvnkCustomer,
  BvnkDryRunPayoutResponse,
  BvnkOnrampPayoutSummary,
} from "@sdp/payments/ramps/providers/bvnk/schemas";
import {
  buildCompleteSettlement,
  bvnkPayoutObservationFromSource,
} from "@sdp/payments/ramps/providers/bvnk/settlement";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import { type AppDb, getDb } from "@/db";
import type {
  BvnkOnrampTransfersRepository,
  ClaimBvnkOnrampPayoutInput,
  FailBvnkOnrampPayoutInput,
  SettleBvnkOnrampPayoutInput,
} from "@/db/repositories/bvnk-onramp-transfers.repository";
import type { PaymentTransferRow } from "@/db/repositories/payments.repository";
import { rootLogger } from "@/runtime/logger";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import {
  bvnkPayoutSummary,
  bvnkProcessingSettlement,
  bvnkSeedCustomerReference,
  seedBvnkOnrampPayinApplied,
  seedBvnkOnrampPayoutClaimed,
  seedBvnkOnrampPayoutIssued,
} from "@/test/helpers/bvnk";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

type ClaimFn = (input: ClaimBvnkOnrampPayoutInput) => Promise<PaymentTransferRow | null>;
type SettleFn = (input: SettleBvnkOnrampPayoutInput) => Promise<PaymentTransferRow | null>;
type FailFn = (input: FailBvnkOnrampPayoutInput) => Promise<PaymentTransferRow | null>;

/**
 * Terminal-write harness: the postgres factory routes claimPayout/settlePayout/
 * failPayout through spies defaulting to the REAL implementation, so one test
 * can stage a single interleaving (lost CAS, identical replay, opposing write).
 */
const bvnkRepoHarness = vi.hoisted(() => {
  const realRepo: { current: BvnkOnrampTransfersRepository | null } = { current: null };
  const real = (): BvnkOnrampTransfersRepository => {
    if (realRepo.current === null) {
      throw new Error("bvnk repo harness: real repository not wired");
    }
    return realRepo.current;
  };
  const claimPayout = vi.fn<ClaimFn>();
  const settlePayout = vi.fn<SettleFn>();
  const failPayout = vi.fn<FailFn>();
  return { real, realRepo, claimPayout, settlePayout, failPayout };
});

vi.mock("@/db/repositories/bvnk-onramp-transfers.repository.postgres", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/db/repositories/bvnk-onramp-transfers.repository.postgres")
    >();
  return {
    ...original,
    createPostgresBvnkOnrampTransfersRepository: (db: AppDb) => {
      const repo = original.createPostgresBvnkOnrampTransfersRepository(db);
      bvnkRepoHarness.realRepo.current = repo;
      return {
        ...repo,
        claimPayout: (input: ClaimBvnkOnrampPayoutInput) => bvnkRepoHarness.claimPayout(input),
        settlePayout: (input: SettleBvnkOnrampPayoutInput) => bvnkRepoHarness.settlePayout(input),
        failPayout: (input: FailBvnkOnrampPayoutInput) => bvnkRepoHarness.failPayout(input),
      };
    },
  };
});

const { reconcileBvnkOnrampPayouts } = await import("./reconcile-bvnk-onramp-payouts");

const TEST_PROJECT_ID = "prj_bvnk_reconcile";
const TEST_PRODUCTION_PROJECT_ID = `${TEST_PROJECT_ID}_production`;
const FUNDING_WALLET = "a:26091832492051:reconcile:1";
const CUSTOMER_REFERENCE = "2acdd3e5-7166-4b04-8115-6ad3ccd66477";
const DESTINATION = "3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF";
const OTHER_WALLET = "a:26091832492051:other:1";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const INTENT = {
  amount: "99.8",
  currency: "USD",
  cryptoCurrency: "USDC",
  network: "SOLANA",
  address: DESTINATION,
} as const;
const PAYOUT_UUID_1 = "01a0b3f2-ad2d-7a55-95dc-98d85d4def2f";
const PAYOUT_UUID_2 = "01a0b3f8-5efa-789e-b9ed-86e9999f29af";
const PAYOUT_UUID_3 = "01a0b3f8-c469-7df1-b24f-a150529c04d1";
const TX_HASH =
  "5hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy";
const FAILED_STATUS_BY_UUID: Record<string, string> = {
  [PAYOUT_UUID_1]: "CANCELLED",
  [PAYOUT_UUID_2]: "EXPIRED",
  [PAYOUT_UUID_3]: "FAILED",
};

const BVNK_CUSTOMER: BvnkCustomer = {
  reference: CUSTOMER_REFERENCE,
  status: "VERIFIED",
  individual: {
    person: {
      firstName: "Jane",
      lastName: "Doe",
      dateOfBirth: "1984-06-30",
      address: {
        addressLine1: "1 Main St",
        city: "Austin",
        postalCode: "78701",
        stateCode: "TX",
        countryCode: "US",
      },
    },
  },
};

const DRY_RUN: BvnkDryRunPayoutResponse = {
  walletCurrency: { currency: "USD", amount: 100, actual: null },
  paidCurrency: { currency: "USDC", amount: 99.8, actual: null },
  feeCurrency: { currency: "USD", amount: 0.2, actual: null },
  networkFeeCurrency: { currency: "USD", amount: 0, actual: null },
  exchangeRate: { base: "USD", counter: "USDC", rate: 0.998 },
};

function payinFor(transferId: string) {
  return {
    id: `payin_${transferId}`,
    receivedAmount: "100.00",
    receivedCurrency: "USD",
    walletId: FUNDING_WALLET,
    customerId: bvnkSeedCustomerReference(transferId),
  };
}

const getCustomerSpy = vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "getCustomer");
const dryRunSpy = vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "dryRunOnrampPayout");
const createSpy = vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "createOnrampPayout");
const listSpy = vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "listPayoutsByReference");
const payoutSummarySpy = vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "getPayoutSummary");
const errorSpy = vi.spyOn(rootLogger, "error");

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

const SEED_SCOPE = {
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT_ID,
  createdBy: TEST_USER.id,
  fundingWalletReference: FUNDING_WALLET,
};

async function seedUnclaimedCandidate(params: {
  id: string;
  projectId?: string;
  token?: string;
}): Promise<void> {
  const db = getDb(env);
  await seedBvnkOnrampPayinApplied(db, {
    ...SEED_SCOPE,
    projectId: params.projectId ?? TEST_PROJECT_ID,
    name: params.id,
    transferId: params.id,
    destinationAddress: DESTINATION,
    payin: payinFor(params.id),
  });
  // The fixture prebooks the symbol; the quote path writes the custody mint, which the asset resolver reads.
  await db
    .prepare("UPDATE payment_transfers SET token = ? WHERE id = ?")
    .bind(params.token ?? USDC_MINT, params.id)
    .run();
}

function seedClaimedCandidate(id: string, pollable: boolean, payoutId?: string): Promise<unknown> {
  const base = {
    ...SEED_SCOPE,
    name: id,
    transferId: id,
    destinationAddress: DESTINATION,
    payin: payinFor(id),
    intent: INTENT,
  };
  if (!pollable) {
    return seedBvnkOnrampPayoutClaimed(getDb(env), { ...base, claimedAt: minutesAgo(6) });
  }
  return seedBvnkOnrampPayoutIssued(getDb(env), {
    ...base,
    claimedAt: minutesAgo(11),
    environment: "sandbox",
    payoutId: payoutId ?? "",
  });
}

async function readTransferRow(id: string): Promise<Record<string, unknown>> {
  const row = await getDb(env)
    .prepare(
      "SELECT provider_data, status, error, signature, destination_address, amount FROM payment_transfers WHERE id = ?"
    )
    .bind(id)
    .first<Record<string, unknown>>();
  assert(row, `transfer ${id} should exist`);
  return row;
}

function bvnkData(row: Record<string, unknown>) {
  return readBvnkOnrampTransferData(
    row.provider_data as Parameters<typeof readBvnkOnrampTransferData>[0]
  );
}

/**
 * A created/relisted summary with the pay-in wallet, the requested NET spend
 * economics, AND the destination the intent claimed, so create/adopt identity
 * checks pass for every status (P1-2): the wire carries the requested address
 * from create (probe payout), so a summary without it is ambiguous.
 */
function payoutSummary(overrides: Partial<BvnkOnrampPayoutSummary> = {}): BvnkOnrampPayoutSummary {
  return bvnkPayoutSummary({
    walletId: FUNDING_WALLET,
    walletCurrency: { currency: "USD", amount: 99.8, actual: 0 },
    address: { address: DESTINATION, network: "SOLANA" },
    ...overrides,
  });
}

/** A PROCESSING summary with the sandbox receipt url pinned to its uuid and the candidate reference. */
function processingSummary(
  transferId: string,
  uuid: string = PAYOUT_UUID_1
): BvnkOnrampPayoutSummary {
  return payoutSummary({
    uuid,
    status: "PROCESSING",
    reference: transferId,
    redirectUrl: `https://pay.sandbox.bvnk.com/payout/${uuid}`,
  });
}

function failedSummary(transferId: string, payoutId: string): BvnkOnrampPayoutSummary {
  return payoutSummary({ uuid: payoutId, status: "FAILED", reference: transferId });
}

function completedSummary(
  transferId: string,
  payoutId: string = PAYOUT_UUID_1,
  hash: string = TX_HASH
): BvnkOnrampPayoutSummary {
  return payoutSummary({
    uuid: payoutId,
    status: "COMPLETED",
    reference: transferId,
    walletCurrency: { currency: "USD", amount: 100, actual: 99.8 },
    paidCurrency: { currency: "USDC", amount: 99.8, actual: 99.8 },
    feeCurrency: { currency: "USD", amount: 0.2, actual: 0.2 },
    transactions: [{ hash }],
    address: { address: DESTINATION, network: "SOLANA" },
  });
}

/** The COMPLETE settlement blob a canonical settle would write for the id. */
function completeSettlementBlob(transferId: string, payoutId: string) {
  const parsed = bvnkPayoutObservationFromSource(completedSummary(transferId, payoutId));
  if (!parsed.ok || parsed.observation.outcome !== "completed") {
    throw new Error("completeSettlementBlob requires a COMPLETED summary");
  }
  return buildCompleteSettlement(
    bvnkProcessingSettlement(transferId, payoutId),
    parsed.observation
  );
}

async function expectDefinitiveFail(id: string, error: string): Promise<void> {
  const row = await readTransferRow(id);
  expect(row).toMatchObject({ status: "failed", error });
  const data = bvnkData(row);
  expect(data.payout).toMatchObject({ attempts: 1, lastError: error });
}

function expectConflictLogged(id: string): void {
  const logged = errorSpy.mock.calls.some((call) => {
    const first = call[0] as Record<string, unknown> | undefined;
    return (
      first?.transfer_id === id && String(first?.error).includes("conflicting payout observation")
    );
  });
  expect(logged).toBe(true);
}

beforeEach(async () => {
  await seedTestDatabase(env);
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
  vi.clearAllMocks();
  bvnkRepoHarness.claimPayout.mockImplementation((input) =>
    bvnkRepoHarness.real().claimPayout(input)
  );
  bvnkRepoHarness.settlePayout.mockImplementation((input) =>
    bvnkRepoHarness.real().settlePayout(input)
  );
  bvnkRepoHarness.failPayout.mockImplementation((input) =>
    bvnkRepoHarness.real().failPayout(input)
  );
  getCustomerSpy.mockResolvedValue(BVNK_CUSTOMER);
  dryRunSpy.mockResolvedValue(DRY_RUN);
  createSpy.mockResolvedValue(processingSummary("xfr_unset"));
  listSpy.mockResolvedValue([]);
});

describe("reconcileBvnkOnrampPayouts", () => {
  describe("unclaimed branch", () => {
    it("claims with the dry-run-derived intent, creates, and records the payout id", async () => {
      await seedUnclaimedCandidate({ id: "xfr_happy" });
      createSpy.mockResolvedValue(processingSummary("xfr_happy"));

      const touched = await reconcileBvnkOnrampPayouts(env);

      expect(touched).toBe(1);
      const row = await readTransferRow("xfr_happy");
      const data = bvnkData(row);
      expect(data.payout?.intent).toEqual(INTENT);
      expect(data.payout?.payoutId).toBe(PAYOUT_UUID_1);
      expect((row.provider_data as Record<string, unknown>).settlement).toMatchObject({
        provider: "bvnk",
        status: "PROCESSING",
        payinId: payinFor("xfr_happy").id,
        payoutId: PAYOUT_UUID_1,
        receiptUrl: "https://pay.sandbox.bvnk.com/payout/01a0b3f2-ad2d-7a55-95dc-98d85d4def2f",
        fiatAmount: "99.8",
        cryptoAmount: "99.8",
        exchangeRate: "0.998",
      });
      expect(dryRunSpy.mock.calls[0]?.[1]).toMatchObject({
        amount: 100,
        currency: "USD",
        reference: "xfr_happy",
        payOutDetails: { currency: "USDC", network: BVNK_PAYOUT_NETWORK.dryRun },
      });
      expect(createSpy.mock.calls[0]?.[1]).toMatchObject({
        amount: 99.8,
        currency: "USD",
        reference: "xfr_happy",
        payOutDetails: {
          code: "crypto",
          currency: "USDC",
          network: BVNK_PAYOUT_NETWORK.create,
        },
      });
    });

    it("dry_run_validation_rejects_definitively_before_claim", async () => {
      for (const [id, feeCurrency, networkFeeCurrency, error] of [
        [
          "xfr_non_fiat_fee",
          { currency: "USDC", amount: 0.2 },
          { currency: "USD", amount: 0 },
          "NON_FIAT_FEE",
        ],
        [
          "xfr_non_fiat_network_fee",
          { currency: "USD", amount: 0.2 },
          { currency: "EUR", amount: 0 },
          "NON_FIAT_FEE",
        ],
        [
          "xfr_fees_exceed_deposit",
          { currency: "USD", amount: 100 },
          { currency: "USD", amount: 0 },
          "FEES_EXCEED_DEPOSIT: fees 100 >= received 100.00",
        ],
      ] as const) {
        await seedUnclaimedCandidate({ id });
        dryRunSpy.mockResolvedValue({
          ...DRY_RUN,
          feeCurrency: { ...feeCurrency, actual: null },
          networkFeeCurrency: { ...networkFeeCurrency, actual: null },
        });

        const touched = await reconcileBvnkOnrampPayouts(env);

        expect(touched).toBe(1);
        await expectDefinitiveFail(id, error);
        const data = bvnkData(await readTransferRow(id));
        expect(data.payout?.intent).toBeUndefined();
        expect(createSpy).not.toHaveBeenCalled();
      }
    });

    it("a_throwing_dry_run_rotates_the_candidate_to_the_back_of_the_queue", async () => {
      await seedUnclaimedCandidate({ id: "xfr_dry_run_throws" });
      const before = await getDb(env)
        .prepare("SELECT updated_at FROM payment_transfers WHERE id = ?")
        .bind("xfr_dry_run_throws")
        .first<{ updated_at: string }>();
      assert(before);
      dryRunSpy.mockRejectedValueOnce(new Error("BVNK dry-run unavailable"));

      await reconcileBvnkOnrampPayouts(env);

      const after = await getDb(env)
        .prepare("SELECT updated_at, status, provider_data FROM payment_transfers WHERE id = ?")
        .bind("xfr_dry_run_throws")
        .first<{ updated_at: string; status: string; provider_data: Record<string, unknown> }>();
      assert(after);
      expect(after.status).toBe("settling");
      expect(after.updated_at > before.updated_at).toBe(true);
      expect(bvnkData(after).payout).toBeUndefined();
      expect(createSpy).not.toHaveBeenCalled();
    });

    it("claim_lost sends no provider create", async () => {
      await seedUnclaimedCandidate({ id: "xfr_claim_lost" });
      bvnkRepoHarness.claimPayout.mockImplementationOnce(async () => null);

      const touched = await reconcileBvnkOnrampPayouts(env);

      expect(touched).toBe(0);
      expect(createSpy).not.toHaveBeenCalled();
      const data = bvnkData(await readTransferRow("xfr_claim_lost"));
      expect(data.payout).toBeUndefined();
    });

    it("definitive_create_rejection_fails_first_attempt", async () => {
      await seedUnclaimedCandidate({ id: "xfr_definitive" });
      createSpy.mockRejectedValue(new BvnkPayRequestError("MER-PAY-2012", "insufficient funds"));

      const touched = await reconcileBvnkOnrampPayouts(env);

      expect(touched).toBe(1);
      await expectDefinitiveFail("xfr_definitive", "MER-PAY-2012");
    });

    it("duplicate_reference_is_ambiguous", async () => {
      await seedUnclaimedCandidate({ id: "xfr_dup" });
      createSpy.mockRejectedValue(
        new BvnkPayRequestError("MER-PAY-2010", "reference already exists")
      );

      const touched = await reconcileBvnkOnrampPayouts(env);

      expect(touched).toBe(1);
      expect(await readTransferRow("xfr_dup")).toMatchObject({ status: "settling", error: null });
      const data = bvnkData(await readTransferRow("xfr_dup"));
      expect(data.payout).toMatchObject({ attempts: 1 });
      expect(data.payout?.payoutId).toBeUndefined();
      expect(data.payout?.lastError).toBeUndefined();
    });

    it("stale_creator_rejection_cannot_fail_recovery_payout", async () => {
      await seedUnclaimedCandidate({ id: "xfr_stale_creator" });
      // REAL interleaving: recovery leased the claim (attempts now 2), so the
      // first-attempt fail fence (attempts = 1) loses the CAS.
      bvnkRepoHarness.claimPayout.mockImplementationOnce(async (input) => {
        const real = bvnkRepoHarness.real();
        const claim = await real.claimPayout(input);
        await real.leasePayoutRecovery({
          transferId: input.transferId,
          observedClaimedAt: input.claimedAt,
          claimedAt: new Date(Date.now() + 60_000).toISOString(),
        });
        return claim;
      });
      createSpy.mockRejectedValue(new BvnkPayRequestError("MER-PAY-2012", "insufficient funds"));

      const touched = await reconcileBvnkOnrampPayouts(env);

      expect(touched).toBe(1);
      expect(await readTransferRow("xfr_stale_creator")).toMatchObject({
        status: "settling",
        error: null,
      });
      const data = bvnkData(await readTransferRow("xfr_stale_creator"));
      expect(data.payout).toMatchObject({ attempts: 2 });
      expect(data.payout?.payoutId).toBeUndefined();
      expect(data.payout?.lastError).toBeUndefined();
    });

    it("unknown_mint_fails_definitively_without_a_claim", async () => {
      await seedUnclaimedCandidate({
        id: "xfr_unknown_mint",
        token: "11111111111111111111111111111111",
      });

      const touched = await reconcileBvnkOnrampPayouts(env);

      expect(touched).toBe(1);
      await expectDefinitiveFail("xfr_unknown_mint", "UNSUPPORTED_ASSET");
      expect(dryRunSpy).not.toHaveBeenCalled();
      const data = bvnkData(await readTransferRow("xfr_unknown_mint"));
      expect(data.payout?.intent).toBeUndefined();
    });

    it("reconciler_uses_candidate_project_credentials", async () => {
      await seedUnclaimedCandidate({ id: "xfr_prod", projectId: TEST_PRODUCTION_PROJECT_ID });
      createSpy.mockResolvedValue(processingSummary("xfr_prod"));

      const touched = await reconcileBvnkOnrampPayouts(env);

      expect(touched).toBe(1);
      expect(dryRunSpy.mock.calls[0]?.[0]).toMatchObject({ mode: "production" });
      expect(createSpy.mock.calls[0]?.[0]).toMatchObject({ mode: "production" });
    });

    it("one_candidate_failure_does_not_abort_batch", async () => {
      await seedUnclaimedCandidate({ id: "xfr_fails" });
      await seedUnclaimedCandidate({ id: "xfr_survives" });
      dryRunSpy.mockImplementation(async (_ctx, input) => {
        if (input.reference === "xfr_fails") {
          throw new Error("provider unavailable");
        }
        return DRY_RUN;
      });
      createSpy.mockResolvedValue(processingSummary("xfr_survives"));

      const touched = await reconcileBvnkOnrampPayouts(env);

      expect(touched).toBe(1);
      expect(await readTransferRow("xfr_survives")).toMatchObject({ status: "settling" });
      expect(bvnkData(await readTransferRow("xfr_fails")).payout).toBeUndefined();
    });
  });

  describe("recovery branch", () => {
    it("adopts the exactly-one matching payout without recreating", async () => {
      await seedClaimedCandidate("xfr_adopt", false);
      listSpy.mockResolvedValue([processingSummary("xfr_adopt", PAYOUT_UUID_2)]);
      payoutSummarySpy.mockResolvedValue(processingSummary("xfr_adopt", PAYOUT_UUID_2));

      const touched = await reconcileBvnkOnrampPayouts(env);

      expect(touched).toBe(1);
      expect(createSpy).not.toHaveBeenCalled();
      const row = await readTransferRow("xfr_adopt");
      const data = bvnkData(row);
      expect(data.payout?.payoutId).toBe(PAYOUT_UUID_2);
      expect(data.payout?.attempts).toBe(2);
      expect((row.provider_data as Record<string, unknown>).settlement).toMatchObject({
        provider: "bvnk",
        status: "PROCESSING",
        payoutId: PAYOUT_UUID_2,
        cryptoAmount: "99.8",
      });
    });

    it("ambiguous_recovery_lookups_stay_claimed", async () => {
      await seedClaimedCandidate("xfr_multi", false);
      // Two listed rows is ambiguous before hydration; one row failing the
      // identity checks (wrong wallet) is ambiguous too.
      listSpy.mockResolvedValueOnce([
        processingSummary("xfr_multi", PAYOUT_UUID_2),
        processingSummary("xfr_multi", PAYOUT_UUID_3),
      ]);
      await seedClaimedCandidate("xfr_adopt_mismatch", false);
      listSpy.mockResolvedValue([processingSummary("xfr_adopt_mismatch", PAYOUT_UUID_2)]);
      payoutSummarySpy.mockResolvedValue(
        payoutSummary({
          uuid: PAYOUT_UUID_2,
          reference: "xfr_adopt_mismatch",
          walletId: OTHER_WALLET,
        })
      );

      const touched = await reconcileBvnkOnrampPayouts(env);

      expect(touched).toBe(2);
      expect(createSpy).not.toHaveBeenCalled();
      for (const id of ["xfr_multi", "xfr_adopt_mismatch"]) {
        const data = bvnkData(await readTransferRow(id));
        expect(data.payout).toMatchObject({ attempts: 2 });
        expect(data.payout?.payoutId).toBeUndefined();
      }
    });

    it("recovery_reuses_persisted_intent and never dry-runs again", async () => {
      await seedClaimedCandidate("xfr_reissue", false);
      createSpy.mockResolvedValue(processingSummary("xfr_reissue"));

      const touched = await reconcileBvnkOnrampPayouts(env);

      expect(touched).toBe(1);
      expect(dryRunSpy).not.toHaveBeenCalled();
      expect(createSpy.mock.calls[0]?.[1]).toMatchObject({
        amount: 99.8,
        currency: "USD",
        reference: "xfr_reissue",
        payOutDetails: {
          code: "crypto",
          currency: "USDC",
          network: BVNK_PAYOUT_NETWORK.create,
        },
      });
      const data = bvnkData(await readTransferRow("xfr_reissue"));
      expect(data.payout?.payoutId).toBe(PAYOUT_UUID_1);
      expect(data.payout?.attempts).toBe(2);
    });

    it("recovery_empty_lookup_then_rejection_remains_ambiguous", async () => {
      await seedClaimedCandidate("xfr_ambiguous", false);
      createSpy.mockRejectedValue(
        new BvnkPayRequestError("MER-PAY-2001", "below the minimum limit")
      );

      const touched = await reconcileBvnkOnrampPayouts(env);

      expect(touched).toBe(1);
      expect(await readTransferRow("xfr_ambiguous")).toMatchObject({
        status: "settling",
        error: null,
      });
      const data = bvnkData(await readTransferRow("xfr_ambiguous"));
      expect(data.payout).toMatchObject({ attempts: 2 });
      expect(data.payout?.payoutId).toBeUndefined();
      expect(data.payout?.lastError).toBeUndefined();
    });
  });

  describe("poll branch", () => {
    it("completed_settles_with_economics", async () => {
      await seedClaimedCandidate("xfr_complete", true, PAYOUT_UUID_1);
      payoutSummarySpy.mockResolvedValue(completedSummary("xfr_complete"));

      const touched = await reconcileBvnkOnrampPayouts(env);

      expect(touched).toBe(1);
      const row = await readTransferRow("xfr_complete");
      expect(row.status).toBe("completed");
      expect(row.signature).toBe(TX_HASH);
      expect(row.destination_address).toBe(DESTINATION);
      expect((row.provider_data as Record<string, unknown>).settlement).toMatchObject({
        provider: "bvnk",
        status: "COMPLETE",
        payoutId: PAYOUT_UUID_1,
        fiatAmount: "100",
        cryptoAmount: "99.8",
        txHash: TX_HASH,
        cryptoAmountActual: "99.8",
        fiatAmountActual: "99.8",
        feeAmountActual: "0.2",
        feeCurrencyActual: "USD",
        exchangeRateActual: "0.998",
      });
    });

    it("polled_status_processing_logs_and_polls", async () => {
      await seedClaimedCandidate("xfr_processing", true, PAYOUT_UUID_1);
      payoutSummarySpy.mockResolvedValue(processingSummary("xfr_processing"));

      const touched = await reconcileBvnkOnrampPayouts(env);

      // The still-settling path: no CAS write, markPolled invoked.
      expect(touched).toBe(1);
      const data = bvnkData(await readTransferRow("xfr_processing"));
      expect(data.payout).toMatchObject({ payoutId: PAYOUT_UUID_1 });
      expect(data.payout?.lastPolledAt).toBeDefined();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("failed_set_cancelled_expired_fail", async () => {
      for (const [id, payoutId] of [
        ["xfr_cancelled", PAYOUT_UUID_1],
        ["xfr_expired", PAYOUT_UUID_2],
        ["xfr_failed", PAYOUT_UUID_3],
      ] as const) {
        await seedClaimedCandidate(id, true, payoutId);
      }
      payoutSummarySpy.mockImplementation((_ctx, input) => {
        const status = FAILED_STATUS_BY_UUID[input.payoutId] ?? "FAILED";
        return Promise.resolve(
          payoutSummary({ uuid: input.payoutId, status, reference: `xfr_${status.toLowerCase()}` })
        );
      });

      const touched = await reconcileBvnkOnrampPayouts(env);

      expect(touched).toBe(3);
      for (const status of Object.values(FAILED_STATUS_BY_UUID)) {
        expect(await readTransferRow(`xfr_${status.toLowerCase()}`)).toMatchObject({
          status: "failed",
          error: status,
        });
        const data = bvnkData(await readTransferRow(`xfr_${status.toLowerCase()}`));
        expect(data.payout?.lastError).toBe(status);
      }
    });

    it("terminal_conflict_is_retained_when_a_competitor_wins", async () => {
      await seedClaimedCandidate("xfr_conflict_complete", true, PAYOUT_UUID_1);
      await seedClaimedCandidate("xfr_conflict_failed", true, PAYOUT_UUID_2);
      await seedClaimedCandidate("xfr_diverged", true, PAYOUT_UUID_3);
      // REAL interleavings: a competitor FAILED one payout, COMPLETED another
      // with canonical economics, and settled the third with a DIFFERENT
      // observed fee. The settle CAS is lost for the first and third, the
      // fail CAS for the second; no re-read matches, so every divergence is
      // retained as a conflicting-payout-observation error.
      bvnkRepoHarness.settlePayout.mockImplementation(async (input) => {
        const real = bvnkRepoHarness.real();
        if (input.transferId === "xfr_conflict_complete") {
          await real.failPayout({
            transferId: input.transferId,
            payoutId: input.payoutId,
            error: "FAILED",
            claimedAt: input.claimedAt,
          });
        } else {
          await real.settlePayout({
            ...input,
            update: {
              ...input.update,
              settlement: { ...input.update.settlement, feeAmountActual: "9.9" },
            },
          });
        }
        return null;
      });
      bvnkRepoHarness.failPayout.mockImplementation(async (input) => {
        await bvnkRepoHarness.real().settlePayout({
          transferId: input.transferId,
          payoutId: input.payoutId ?? "",
          claimedAt: input.claimedAt,
          update: {
            signature: TX_HASH,
            destinationAddress: DESTINATION,
            amount: "99.8",
            settlement: completeSettlementBlob(input.transferId, input.payoutId ?? PAYOUT_UUID_2),
          },
        });
        return null;
      });
      // The diverged competitor settles with its OWN hash: `signature` is
      // unique across payment_transfers, so a shared TX_HASH would violate
      // the index instead of exercising the conflict retention.
      const DIVERGED_TX_HASH =
        "3B9neiFe2HG3P8ovttfH1XrppubeFtMcKWZDhw9rzLUqUSQrfLYdzpC3v3ctsbtQBt1rwUPkBaa4SWG2SZzqtXD3";
      payoutSummarySpy.mockImplementation((_ctx, input) =>
        Promise.resolve(
          input.payoutId === PAYOUT_UUID_2
            ? failedSummary("xfr_conflict_failed", PAYOUT_UUID_2)
            : input.payoutId === PAYOUT_UUID_3
              ? completedSummary("xfr_diverged", PAYOUT_UUID_3, DIVERGED_TX_HASH)
              : completedSummary("xfr_conflict_complete")
        )
      );

      const touched = await reconcileBvnkOnrampPayouts(env);

      expect(touched).toBe(0);
      expect((await readTransferRow("xfr_conflict_complete")).status).toBe("failed");
      expect((await readTransferRow("xfr_conflict_failed")).status).toBe("completed");
      expect((await readTransferRow("xfr_diverged")).status).toBe("completed");
      expectConflictLogged("xfr_conflict_complete");
      expectConflictLogged("xfr_conflict_failed");
      expectConflictLogged("xfr_diverged");
    });
  });
});
