import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { mintAdmittedMovementForTests } from "@/lib/admit-movement";
import { buildEarnVaultParRedemptionFingerprint } from "@/lib/idempotency";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

const quoteParRedemption = vi.hoisted(() => vi.fn());
const buildParRedemptionRequest = vi.hoisted(() => vi.fn());
const simulateVaultPlan = vi.hoisted(() => vi.fn());
const signVaultPlan = vi.hoisted(() => vi.fn());
const broadcastVaultTransaction = vi.hoisted(() => vi.fn());
const compileUnsignedVaultTransaction = vi.hoisted(() => vi.fn());
const createOrgSignerForCustodyWallet = vi.hoisted(() => vi.fn());
const resolveVaultSponsorship = vi.hoisted(() => vi.fn());
const verifySignedExternalWalletTransaction = vi.hoisted(() => vi.fn());
const readConfirmedBlockHeight = vi.hoisted(() => vi.fn());

vi.mock("./execution-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./execution-registry")>()),
  resolveVaultParRedemptionClient: () => ({ quoteParRedemption, buildParRedemptionRequest }),
  resolveClusterRpcUrl: () => "https://rpc.example.invalid",
}));
vi.mock("./vault-execution.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./vault-execution.service")>()),
  simulateVaultPlan,
  signVaultPlan,
  broadcastVaultTransaction,
  compileUnsignedVaultTransaction,
}));
vi.mock("@/services/solana", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/solana")>()),
  createOrgSignerForCustodyWallet,
}));
vi.mock("./vault-sponsorship", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./vault-sponsorship")>()),
  resolveVaultSponsorship,
}));
vi.mock("./vault-external-wallet.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./vault-external-wallet.service")>()),
  verifySignedExternalWalletTransaction,
}));
vi.mock("./vault-intent-execution.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./vault-intent-execution.service")>()),
  readConfirmedBlockHeight,
}));

const {
  buildExternalQueuedWithdrawalRequest,
  createCustodyQueuedWithdrawal,
  submitExternalQueuedWithdrawalAction,
} = await import("./vault-queued-withdraw.service");

const ORG = "org_par_intermediate";
const PROJECT = "prj_par_intermediate";
const USER = "usr_par_intermediate";
const WALLET_ROW_ID = "cwlt_par_intermediate";
const WALLET_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const EXTERNAL_OWNER = "C4XGF8r1gQP7p2PeKcRAFNwGAU1gCxiinRufqddY1m98";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PRIME_MINT = "3b8X44fLF9ooXaUm3hhSgjpmVs6rZZ3pPoGnGahc3Uu7";
const WYLDS_MINT = "8fr7WGTVFszfyNWRMXj6fRjZZAnDwmXwEpCrtzmUkdih";
const CUSTODY_POSITION = "earn_position_par_intermediate_custody";
const EXTERNAL_POSITION = "earn_position_par_intermediate_external";
const CUSTODY_REQUEST = "ParIntermediateCustodyRequest11111111111";
const EXTERNAL_REQUEST = "ParIntermediateExternalRequest1111111111";
const terms = { mechanism: "operator_redemption", intermediateAmount: "2000" } as const;

function heldIntermediatePlan(requestAddress: string, shares = "0") {
  return {
    cluster: "devnet",
    instructions: [{ programAddress: "11111111111111111111111111111111", accounts: [], data: "" }],
    lookupTables: [],
    assetIdentity: { depositTokenMint: USDC_MINT, shareMint: PRIME_MINT },
    requestAddress,
    expectedRequest: {
      shares,
      intermediateMint: WYLDS_MINT,
      intermediateAmount: "2000",
      assetMint: USDC_MINT,
      assets: "2000",
    },
  };
}

function position(id: string, ownerAddress: string, custodyWalletId: string | null) {
  return {
    id,
    provider: "hastra",
    vaultAddress: PRIME_MINT,
    tokenMint: USDC_MINT,
    shareMint: PRIME_MINT,
    ownerAddress,
    custodyWalletId,
  };
}

async function seed(): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORG, "Par Intermediate Org", "par-intermediate", "enterprise", "active"),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(USER, "par-intermediate@example.com", 1, "active"),
  ]);
  await seedDefaultProjects(db, {
    organizationId: ORG,
    createdBy: USER,
    members: [],
    ids: { sandbox: PROJECT, production: `${PROJECT}_production` },
  });
  await db.batch([
    db
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES ('cfg_par_intermediate', ?, ?, 'privy', 'test-encrypted', 'active')`
      )
      .bind(ORG, PROJECT),
    db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, 'cfg_par_intermediate', 'privy_par_intermediate', ?, 'active')`
      )
      .bind(WALLET_ROW_ID, WALLET_ADDRESS),
    db
      .prepare(
        `INSERT INTO earn_positions (
           id, organization_id, project_id, environment, provider, kind,
           custody_wallet_id, vault_address, share_mint, token_mint, label, activated_at
         ) VALUES (?, ?, ?, 'sandbox', 'hastra', 'vault_direct', ?, ?, ?, ?, 'Hastra PRIME',
                   sdp_iso_now())`
      )
      .bind(CUSTODY_POSITION, ORG, PROJECT, WALLET_ROW_ID, PRIME_MINT, PRIME_MINT, USDC_MINT),
    db
      .prepare(
        `INSERT INTO earn_positions (
           id, organization_id, project_id, environment, provider, kind,
           owner_address, vault_address, share_mint, token_mint, label, activated_at
         ) VALUES (?, ?, ?, 'sandbox', 'hastra', 'vault_direct', ?, ?, ?, ?, 'Hastra PRIME',
                   sdp_iso_now())`
      )
      .bind(EXTERNAL_POSITION, ORG, PROJECT, EXTERNAL_OWNER, PRIME_MINT, PRIME_MINT, USDC_MINT),
  ]);
}

beforeEach(async () => {
  await seedTestDatabase(env);
  await seed();
  vi.clearAllMocks();
  quoteParRedemption.mockResolvedValue({
    shares: "0",
    shareDecimals: 6,
    intermediateMint: WYLDS_MINT,
    intermediateAmount: "2000",
    assetMint: USDC_MINT,
    assets: "2000",
    assetDecimals: 6,
    blockingIssues: [],
  });
  resolveVaultSponsorship.mockResolvedValue({ kind: "wallet-pays" });
  simulateVaultPlan.mockResolvedValue({ ok: true, prepared: {} });
  createOrgSignerForCustodyWallet.mockResolvedValue({ address: WALLET_ADDRESS });
  signVaultPlan.mockResolvedValue({
    bytes: new Uint8Array([1, 2, 3]),
    signature: "sig_par_intermediate_custody",
    lastValidBlockHeight: "12345",
  });
  broadcastVaultTransaction.mockResolvedValue(undefined);
  compileUnsignedVaultTransaction.mockReturnValue({
    bytes: new Uint8Array([9, 9]),
    lastValidBlockHeight: "20000",
  });
  readConfirmedBlockHeight.mockResolvedValue(100n);
  verifySignedExternalWalletTransaction.mockResolvedValue({
    signature: "sig_par_intermediate_external",
    signedTransactionBase64: "CQk=",
  });
});

describe("a par request over held intermediate", () => {
  it("builds, signs and records a custody request that burns no shares", async () => {
    buildParRedemptionRequest.mockResolvedValue(heldIntermediatePlan(CUSTODY_REQUEST));

    const result = await createCustodyQueuedWithdrawal(env, {
      actor: {
        organizationId: ORG,
        projectId: PROJECT,
        environment: "sandbox",
        custodyWalletId: WALLET_ROW_ID,
        custodyWalletPublicKey: WALLET_ADDRESS,
        userId: USER,
      },
      movement: mintAdmittedMovementForTests({
        organizationId: ORG,
        projectId: PROJECT,
        purpose: "earn.withdraw",
      }),
      position: position(CUSTODY_POSITION, WALLET_ADDRESS, WALLET_ROW_ID),
      terms,
      clientRequestId: "par-intermediate-custody-key",
    });

    const source = { providerReference: PRIME_MINT, intermediateAmount: "2000" };
    expect(quoteParRedemption).toHaveBeenCalledWith(expect.anything(), source);
    expect(buildParRedemptionRequest).toHaveBeenCalledWith(expect.anything(), {
      ...source,
      owner: WALLET_ADDRESS,
    });
    expect(result.request).toMatchObject({
      mechanism: "operator_redemption",
      shares: "0",
      intermediate_mint: WYLDS_MINT,
      intermediate_amount: "2000",
      idempotency_fingerprint: buildEarnVaultParRedemptionFingerprint({
        environment: "sandbox",
        provider: "hastra",
        positionId: CUSTODY_POSITION,
        intermediateAmount: "2000",
      }),
    });
    expect(result.action).toMatchObject({ status: "submitted" });
  });

  it("refuses a build that burns shares the caller did not ask to redeem", async () => {
    buildParRedemptionRequest.mockResolvedValue(heldIntermediatePlan(CUSTODY_REQUEST, "1"));

    await expect(
      createCustodyQueuedWithdrawal(env, {
        actor: {
          organizationId: ORG,
          projectId: PROJECT,
          environment: "sandbox",
          custodyWalletId: WALLET_ROW_ID,
          custodyWalletPublicKey: WALLET_ADDRESS,
          userId: USER,
        },
        movement: mintAdmittedMovementForTests({
          organizationId: ORG,
          projectId: PROJECT,
          purpose: "earn.withdraw",
        }),
        position: position(CUSTODY_POSITION, WALLET_ADDRESS, WALLET_ROW_ID),
        terms,
        clientRequestId: "par-intermediate-drift-key",
      })
    ).rejects.toThrow(/changed the position asset identity or the requested amount/);
    expect(signVaultPlan).not.toHaveBeenCalled();
  });

  it("persists an external build and reconstructs the held source on submit", async () => {
    buildParRedemptionRequest.mockResolvedValue(heldIntermediatePlan(EXTERNAL_REQUEST));
    const actor = {
      organizationId: ORG,
      projectId: PROJECT,
      environment: "sandbox" as const,
      userId: USER,
    };

    const built = await buildExternalQueuedWithdrawalRequest(env, {
      actor,
      position: position(EXTERNAL_POSITION, EXTERNAL_OWNER, null),
      terms,
    });
    expect(built).toMatchObject({
      action: "request",
      mechanism: "operator_redemption",
      shares: "0",
      intermediate_amount: "2000",
    });

    // A signed build may already have been broadcast by its owner. Expiry
    // cannot authorize forgetting it or asking for a newly signed request.
    readConfirmedBlockHeight.mockResolvedValue(99999n);
    broadcastVaultTransaction.mockRejectedValueOnce(new Error("Blockhash not found"));
    const submitted = await submitExternalQueuedWithdrawalAction(env, {
      actor,
      transactionId: built.id,
      signedTransaction: "CQk=",
      clientRequestId: "par-intermediate-external-key",
      action: "request",
    });
    expect(submitted.action).toMatchObject({ status: "requested" });
    expect(submitted.request).toMatchObject({
      shares: "0",
      intermediate_amount: "2000",
      idempotency_fingerprint: buildEarnVaultParRedemptionFingerprint({
        environment: "sandbox",
        provider: "hastra",
        positionId: EXTERNAL_POSITION,
        intermediateAmount: "2000",
        transactionId: built.id,
      }),
    });
    expect(broadcastVaultTransaction).toHaveBeenCalledTimes(1);
  });
});
