import { runInClusterScope } from "@sdp/rpc/scope";
import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { type Address, address, type Signature } from "@solana/kit";
import { findSubscriptionAuthorityPda } from "@solana/subscriptions";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { runWithSystemDatabaseIdentity } from "@/db/identity";
import { createPostgresCounterpartiesRepository } from "@/db/repositories/counterparty.repository.postgres";
import { createPostgresCounterpartyAccountsRepository } from "@/db/repositories/counterparty-account.repository.postgres";
import { createPostgresPaymentRecurringPaymentsRepository } from "@/db/repositories/payment-recurring-payments.repository.postgres";
import { transactionFailed } from "@/lib/errors";
import type { SignedSubmissionStore } from "@/services/sponsorship-submission";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedRecurringDatabaseTenant } from "@/test/helpers/recurring-payments";
import { required } from "@/test/helpers/required";
import { seedTestDatabase } from "@/test/mocks/db";

/**
 * The cron's failure handling around one revoke (HOO-2210). The chain, the custody signer and the
 * sponsored send are faked; the revoke rows are real. The Surfpool suite
 * (`recurring-payments-authority-revocation.test.ts` in @sdp/api-integration) covers the
 * revoke itself on chain.
 */

const mocks = vi.hoisted(() => ({
  fetchAuthority: vi.fn(),
  send: vi.fn(),
  confirm: vi.fn(),
  readSavedSend: vi.fn(),
  revokeInputs: [] as unknown[],
  signerMovements: [] as string[],
}));

vi.mock("@sdp/rpc/factory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sdp/rpc/factory")>()),
  createClusterRpc: () => ({}),
}));

vi.mock("@solana/subscriptions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@solana/subscriptions")>()),
  fetchMaybeSubscriptionAuthority: mocks.fetchAuthority,
  getRevokeSubscriptionAuthorityOverlayInstructionAsync: async (input: unknown) => {
    mocks.revokeInputs.push(input);
    return { programAddress: "De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44" };
  },
}));

vi.mock("./shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared")>()),
  sendSubscriptionInstructions: mocks.send,
  confirmSubscriptionSignature: mocks.confirm,
  readSavedSend: mocks.readSavedSend,
}));

vi.mock("@/services/solana/signer", () => ({
  createOrgSignerForCustodyWallet: async (
    _env: unknown,
    _organizationId: string,
    _projectId: string,
    _walletId: string,
    movement: string
  ) => {
    mocks.signerMovements.push(movement);
    return { address: WALLET };
  },
}));

vi.mock("@/services/domain/signing/custody-runtime-target", () => ({
  CustodyRuntimeTargets: class {
    async findOperationalWalletById() {
      return { id: CUSTODY_WALLET_ID, walletId: PROVIDER_WALLET_ID, publicKey: WALLET };
    }
  },
}));

vi.mock("@/routes/payments/token-accounts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/routes/payments/token-accounts")>()),
  resolveMintTokenProgram: async () => TOKEN_PROGRAM_ADDRESS,
}));

const { revokeIdleSubscriptionAuthorities } = await import("./authority-revocation");

const PROJECT_ID = "prj_authority_revocation_service_test";
const CUSTODY_WALLET_ID = "cwlt_authority_revocation_service_test";
const PROVIDER_WALLET_ID = "wallet_authority_revocation_service_test";
const WALLET = address("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
const MINT = address(WELL_KNOWN_TOKENS.USDC.mints.devnet.address);
const SPONSOR = address("11111111111111111111111111111112");
const SIGNATURE = "5".repeat(88) as Signature;
const NOW = new Date("2026-10-21T12:00:00.000Z");
const LONG_AGO = "2026-10-19T12:00:00.000Z";

let authority: Address;

function openAuthority() {
  return {
    exists: true,
    address: authority,
    data: { payer: SPONSOR, user: WALLET, tokenMint: MINT, bump: 255, initId: 1n },
  };
}

/** A send that saves its signature, as the sponsored path does before broadcasting it. */
function sendThatSaves(after: () => Promise<Signature>) {
  return async ({ submissionStore }: { submissionStore: SignedSubmissionStore }) => {
    await submissionStore.persistSigned({
      signature: SIGNATURE,
      signedTransaction: "AQ==",
      lastValidBlockHeight: "100",
    });
    return after();
  };
}

function sweep(at: Date = NOW) {
  return runInClusterScope({ projectId: null, environment: "sandbox" }, () =>
    runWithSystemDatabaseIdentity("test:authority-revocation", () =>
      revokeIdleSubscriptionAuthorities(env, at)
    )
  );
}

async function revocations() {
  return getDb(env).queryMany<{ status: string; signature: string | null; error: string | null }>(
    "SELECT status, signature, error FROM payment_subscription_authority_revocations ORDER BY created_at"
  );
}

describe("revokeIdleSubscriptionAuthorities", () => {
  beforeAll(async () => {
    await seedTestDatabase(env);
    [authority] = await findSubscriptionAuthorityPda({ user: WALLET, tokenMint: MINT });
  });

  afterAll(async () => {
    await seedTestDatabase(env);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.signerMovements.length = 0;
    mocks.revokeInputs.length = 0;
    const db = getDb(env);
    await db.prepare("DELETE FROM payment_subscription_authority_revocations").run();
    await db.prepare("DELETE FROM payment_recurring_payments").run();
    await db.prepare("DELETE FROM counterparty_accounts").run();
    await db.prepare("DELETE FROM counterparties").run();
    await db.prepare("DELETE FROM projects").run();
    await seedRecurringDatabaseTenant({
      organizationId: TEST_ORG.id,
      organizationName: TEST_ORG.name,
      organizationSlug: TEST_ORG.slug,
      userId: TEST_USER.id,
      userEmail: TEST_USER.email,
      projectId: PROJECT_ID,
      custodyConfigId: "cfg_authority_revocation_service_test",
      custodyWalletId: CUSTODY_WALLET_ID,
      providerWalletId: PROVIDER_WALLET_ID,
      publicKey: WALLET,
    });
    const counterparty = required(
      await createPostgresCounterpartiesRepository(db).createCounterparty({
        organizationId: TEST_ORG.id,
        projectId: PROJECT_ID,
        externalId: null,
        entityType: "individual",
        displayName: "Recipient",
        providerData: {},
        createdBy: TEST_USER.id,
      })
    );
    const account = required(
      await createPostgresCounterpartyAccountsRepository(db).createCounterpartyAccount({
        organizationId: TEST_ORG.id,
        projectId: PROJECT_ID,
        counterpartyId: counterparty.id,
        accountKind: "crypto_wallet",
        label: "Recipient Solana",
        details: { network: "solana", address: "Destination111111111111111111111111111111" },
      })
    );
    required(
      await createPostgresPaymentRecurringPaymentsRepository(db).createRecurringPayment({
        id: "recpay_authority_service",
        organizationId: TEST_ORG.id,
        projectId: PROJECT_ID,
        sourceCustodyWalletId: CUSTODY_WALLET_ID,
        sourceWalletId: PROVIDER_WALLET_ID,
        sourceAddress: WALLET,
        counterpartyId: counterparty.id,
        counterpartyAccountId: account.id,
        destinationAddress: "Destination111111111111111111111111111111",
        token: MINT,
        amount: "1",
        periodHours: 24,
        firstCollectionAt: null,
        metadataUri: null,
        createdBy: TEST_USER.id,
        createdAt: LONG_AGO,
        updatedAt: LONG_AGO,
        idempotencyKey: null,
        idempotencyFingerprint: null,
      })
    );
    await db.execute(
      `UPDATE payment_recurring_payments
          SET status = 'canceled', subscription_authority_address = ?, updated_at = ?
        WHERE id = 'recpay_authority_service'`,
      [authority, LONG_AGO]
    );
    mocks.fetchAuthority.mockResolvedValue(openAuthority());
    mocks.confirm.mockResolvedValue(undefined);
  });

  it("revokes as an exit with no principal, refunding the rent to the payer it recorded", async () => {
    mocks.send.mockImplementation(sendThatSaves(async () => SIGNATURE));

    expect(await sweep()).toEqual({ revoked: 1, recovered: 0, failed: 0, skipped: 0 });
    expect(mocks.signerMovements).toEqual(["recurring.revoke_authority"]);
    expect(mocks.revokeInputs).toEqual([
      expect.objectContaining({ tokenMint: MINT, receiver: SPONSOR }),
    ]);
    expect(mocks.send).toHaveBeenCalledWith(
      expect.objectContaining({ movement: "recurring.revoke_authority" })
    );
    expect(await revocations()).toEqual([
      { status: "confirmed", signature: SIGNATURE, error: null },
    ]);
    expect(await sweep()).toEqual({ revoked: 0, recovered: 0, failed: 0, skipped: 0 });
  });

  it("confirms without sending when the authority is already gone", async () => {
    mocks.fetchAuthority.mockResolvedValue({ exists: false, address: authority });

    expect(await sweep()).toMatchObject({ revoked: 1 });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(await revocations()).toEqual([{ status: "confirmed", signature: null, error: null }]);
  });

  it("fails a revoke refused before broadcast, and retries it after the retry window", async () => {
    mocks.send.mockRejectedValueOnce(transactionFailed("preflight refused"));

    expect(await sweep()).toMatchObject({ revoked: 0, failed: 1 });
    expect(await revocations()).toEqual([
      { status: "failed", signature: null, error: "preflight refused" },
    ]);
    expect(await sweep()).toMatchObject({ revoked: 0, failed: 0 });

    // The failure is stamped with the wall clock; pin it to the tick so the window is exact.
    await getDb(env).execute(
      "UPDATE payment_subscription_authority_revocations SET updated_at = ?",
      [NOW.toISOString()]
    );
    mocks.send.mockImplementation(sendThatSaves(async () => SIGNATURE));
    expect(await sweep(new Date(NOW.getTime() + 7 * 60 * 60 * 1000))).toMatchObject({ revoked: 1 });
  });

  it("holds a revoke whose send may have landed, then settles it from the chain", async () => {
    mocks.send.mockImplementation(
      sendThatSaves(async () => {
        throw new Error("socket hang up");
      })
    );

    expect(await sweep()).toEqual({ revoked: 0, recovered: 0, failed: 0, skipped: 0 });
    expect(await revocations()).toEqual([
      { status: "processing", signature: SIGNATURE, error: null },
    ]);

    // Inside the stale window the sweep leaves it alone, and no second revoke is claimed.
    expect(await sweep(new Date(NOW.getTime() + 60_000))).toMatchObject({ recovered: 0 });
    expect(mocks.send).toHaveBeenCalledTimes(1);

    // Past it, the saved send may still land: wait.
    const later = new Date(NOW.getTime() + 20 * 60 * 1000);
    await getDb(env).execute(
      "UPDATE payment_subscription_authority_revocations SET updated_at = ?",
      [NOW.toISOString()]
    );
    mocks.readSavedSend.mockResolvedValueOnce("pending");
    expect(await sweep(later)).toMatchObject({ recovered: 0 });
    expect(mocks.send).toHaveBeenCalledTimes(1);

    // It expired without landing: send it again, and it lands.
    await getDb(env).execute(
      "UPDATE payment_subscription_authority_revocations SET updated_at = ?",
      [NOW.toISOString()]
    );
    mocks.readSavedSend.mockResolvedValueOnce("expired");
    mocks.send.mockImplementation(sendThatSaves(async () => SIGNATURE));
    expect(await sweep(later)).toMatchObject({ recovered: 1 });
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(await revocations()).toEqual([
      { status: "confirmed", signature: SIGNATURE, error: null },
    ]);
  });

  it("confirms a held revoke once the chain shows the authority gone at finalized", async () => {
    mocks.send.mockImplementation(
      sendThatSaves(async () => {
        throw new Error("socket hang up");
      })
    );
    await sweep();
    await getDb(env).execute(
      "UPDATE payment_subscription_authority_revocations SET updated_at = ?",
      ["2026-10-21T11:00:00.000Z"]
    );
    mocks.fetchAuthority.mockResolvedValue({ exists: false, address: authority });

    expect(await sweep()).toMatchObject({ recovered: 1 });
    expect(mocks.fetchAuthority).toHaveBeenLastCalledWith(expect.anything(), authority, {
      commitment: "finalized",
    });
    expect(await revocations()).toEqual([
      { status: "confirmed", signature: SIGNATURE, error: null },
    ]);
  });

  it("makes no RPC call when there is nothing to revoke", async () => {
    await getDb(env).execute(
      "UPDATE payment_recurring_payments SET status = 'canceling' WHERE id = 'recpay_authority_service'"
    );

    expect(await sweep()).toEqual({ revoked: 0, recovered: 0, failed: 0, skipped: 0 });
    expect(mocks.fetchAuthority).not.toHaveBeenCalled();
  });
});
