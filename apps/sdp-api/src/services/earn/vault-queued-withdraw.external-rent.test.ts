import {
  type Blockhash,
  generateKeyPair,
  getAddressFromPublicKey,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
} from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

const quoteParRedemption = vi.hoisted(() => vi.fn());
const buildParRedemptionRequest = vi.hoisted(() => vi.fn());
const resolveVaultParRedemptionClient = vi.hoisted(() => vi.fn());
const simulateVaultPlan = vi.hoisted(() => vi.fn());
const broadcastVaultTransaction = vi.hoisted(() => vi.fn());
const getBlockHeight = vi.hoisted(() => vi.fn());

vi.mock("@sdp/rpc/solana", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sdp/rpc/solana")>()),
  createRpc: () => ({ getBlockHeight: () => ({ send: getBlockHeight }) }),
}));

vi.mock("./execution-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./execution-registry")>()),
  resolveVaultParRedemptionClient,
  resolveClusterRpcUrl: () => "https://rpc.example.invalid",
}));

vi.mock("./vault-execution.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./vault-execution.service")>()),
  simulateVaultPlan,
  broadcastVaultTransaction,
}));

const { buildExternalQueuedWithdrawalRequest, submitExternalQueuedWithdrawalAction } = await import(
  "./vault-queued-withdraw.service"
);

/**
 * The queued external-wallet operator-redemption rent contract (SOLA9-228):
 * the partner fee payer funds the owner's persistent wYLDS and USDC ATA
 * creates, so the durable build, the submitted request, and the eventual
 * fulfillment movement must all carry WHO funded them — the chain the exit's
 * refund logic reads — instead of leaving only `fee_payer` behind.
 */

const ORG = "org_queued_output_rent";
const PROJECT = "prj_queued_output_rent";
const USER = "usr_queued_output_rent";
const TOKEN_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SHARE_MINT = "HZfQueuedOutputShare1111111111111111111111";
const WYLDS_MINT = "8fr7WGTVFszfyNWRMXj6fRjZZAnDwmXwEpCrtzmUkdih";
const VAULT = "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx";
const PAR_REQUEST_ADDRESS = "KqQueueOutputRentParRequest111111111111111";
const MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
// 32 base58 ones decode to 32 zero bytes — a structurally valid blockhash.
const BLOCKHASH = "11111111111111111111111111111111" as Blockhash;

let ownerKeyPair: CryptoKeyPair;
let ownerAddress: string;
let partnerKeyPair: CryptoKeyPair;
let partnerAddress: string;
let positionId: string;

function ataCreateInstruction(funder: string, owner: string) {
  return {
    programAddress: MEMO_PROGRAM_ADDRESS,
    accounts: [
      // The idempotent ATA create charges the funder and builds an
      // owner-owned account, so the owner must still authorize.
      { address: funder, role: 3 },
      { address: owner, role: 2 },
    ],
    data: Buffer.from("ata-create-idempotent", "utf8").toString("base64"),
  };
}

function parPlan(overrides: Record<string, unknown> = {}) {
  return {
    cluster: "devnet",
    instructions: [ataCreateInstruction(partnerAddress, ownerAddress)],
    lookupTables: [],
    assetIdentity: { depositTokenMint: TOKEN_MINT, shareMint: SHARE_MINT },
    accepted: { shares: "10" },
    requestAddress: PAR_REQUEST_ADDRESS,
    expectedRequest: {
      shares: "10",
      intermediateMint: WYLDS_MINT,
      intermediateAmount: "12.5",
      assetMint: TOKEN_MINT,
      assets: "12.5",
    },
    ...overrides,
  };
}

function quote() {
  return {
    shares: "10",
    shareDecimals: 6,
    intermediateMint: WYLDS_MINT,
    intermediateAmount: "12.5",
    assetMint: TOKEN_MINT,
    assetDecimals: 6,
    assets: "12.5",
    blockingIssues: [],
  };
}

function position() {
  return {
    id: positionId,
    provider: "hastra",
    vaultAddress: VAULT,
    tokenMint: TOKEN_MINT,
    shareMint: SHARE_MINT,
    ownerAddress,
  };
}

function buildInput(overrides: Record<string, unknown> = {}) {
  return {
    actor: {
      organizationId: ORG,
      projectId: PROJECT,
      environment: "sandbox" as const,
      userId: USER,
      apiKeyId: null,
    },
    position: position(),
    terms: { mechanism: "operator_redemption" as const, shares: "10" },
    // The default plan charges the partner for its ATA create, so the partner
    // rides in the fee-payer seat beside the owner.
    feePayer: partnerAddress,
    ...overrides,
  };
}

async function requestRow(requestId: string) {
  return getDb(env)
    .prepare(
      `SELECT creates_output_accounts, output_accounts_rent_funder
         FROM earn_vault_withdrawal_requests WHERE id = ?`
    )
    .bind(requestId)
    .first<{ creates_output_accounts: boolean; output_accounts_rent_funder: string | null }>();
}

beforeEach(async () => {
  await seedTestDatabase(env);
  vi.clearAllMocks();

  ownerKeyPair = await generateKeyPair();
  ownerAddress = await getAddressFromPublicKey(ownerKeyPair.publicKey);
  partnerKeyPair = await generateKeyPair();
  partnerAddress = await getAddressFromPublicKey(partnerKeyPair.publicKey);

  const db = getDb(env);
  await db.batch([
    db
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORG, "Queued Output Rent Org", "queued-output-rent", "enterprise", "active"),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(USER, "queued-output-rent@example.com"),
  ]);
  await seedDefaultProjects(db, {
    organizationId: ORG,
    createdBy: USER,
    members: [],
    ids: { sandbox: PROJECT, production: `${PROJECT}_production` },
  });
  positionId = "earn_position_queued_output_rent";
  await db
    .prepare(
      `INSERT INTO earn_positions (
         id, organization_id, project_id, environment, provider, kind,
         owner_address, vault_address, share_mint, token_mint, label, activated_at
       ) VALUES (?, ?, ?, 'sandbox', 'hastra', 'vault_direct', ?, ?, ?, ?, 'Par Vault', sdp_iso_now())`
    )
    .bind(positionId, ORG, PROJECT, ownerAddress, VAULT, SHARE_MINT, TOKEN_MINT)
    .run();

  resolveVaultParRedemptionClient.mockReturnValue({
    quoteParRedemption,
    buildParRedemptionRequest,
  });
  quoteParRedemption.mockResolvedValue(quote());
  buildParRedemptionRequest.mockResolvedValue(
    parPlan({
      createdOutputAtas: [
        {
          mint: WYLDS_MINT,
          address: "WyldsAtaPlaceholder1111111111111111111111111",
          rentFunder: partnerAddress,
        },
        {
          mint: TOKEN_MINT,
          address: "UsdcAtaPlaceholder111111111111111111111111111",
          rentFunder: partnerAddress,
        },
      ],
    })
  );
  simulateVaultPlan.mockImplementation(async (_env, input) => ({
    ok: true,
    prepared: {
      plan: input.plan,
      lookupTables: {},
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 361n,
    },
  }));
  broadcastVaultTransaction.mockResolvedValue(undefined);
  // Well inside the stubbed build window (lastValidBlockHeight 361).
  getBlockHeight.mockResolvedValue(100n);
});

describe("queued operator-redemption output-ATA rent attribution (SOLA9-228)", () => {
  it("records the partner as the output-ATA rent funder on the durable build", async () => {
    const built = await buildExternalQueuedWithdrawalRequest(env, buildInput());

    expect(built.creates_output_accounts).toBe(true);
    expect(built.output_accounts_rent_funder).toBe(partnerAddress);
    expect(built.fee_payer).toBe(partnerAddress);
    const row = await getDb(env)
      .prepare(
        `SELECT creates_output_accounts, output_accounts_rent_funder
           FROM earn_external_wallet_withdrawal_request_transactions WHERE id = ?`
      )
      .bind(built.id)
      .first<{ creates_output_accounts: boolean; output_accounts_rent_funder: string | null }>();
    expect(row).toEqual({
      creates_output_accounts: true,
      output_accounts_rent_funder: partnerAddress,
    });
  });

  it("records no funder when the plan creates no persistent output account", async () => {
    buildParRedemptionRequest.mockResolvedValue(parPlan());
    const built = await buildExternalQueuedWithdrawalRequest(env, buildInput());

    expect(built.creates_output_accounts).toBe(false);
    expect(built.output_accounts_rent_funder).toBeNull();
  });

  it("records no funder when the owner funds its own output accounts", async () => {
    buildParRedemptionRequest.mockResolvedValue(
      parPlan({
        instructions: [ataCreateInstruction(ownerAddress, ownerAddress)],
        createdOutputAtas: [
          {
            mint: WYLDS_MINT,
            address: "WyldsAtaPlaceholder1111111111111111111111111",
            rentFunder: ownerAddress,
          },
        ],
      })
    );
    // Owner-pays build: no fee-payer seat, the owner's signature alone.
    const built = await buildExternalQueuedWithdrawalRequest(
      env,
      buildInput({ feePayer: undefined })
    );

    // The owner-funded create charges nobody else, so the refund must default
    // back to the owner — recording the owner here would be a no-op claim at
    // best and a misattribution once a partner entry superseded it.
    expect(built.creates_output_accounts).toBe(true);
    expect(built.output_accounts_rent_funder).toBeNull();
  });

  it("carries the attribution onto the submitted request for the fulfillment refund", async () => {
    const built = await buildExternalQueuedWithdrawalRequest(env, buildInput());
    const transaction = getTransactionDecoder().decode(
      Uint8Array.from(Buffer.from(built.unsigned_transaction, "base64"))
    );
    const signed = await partiallySignTransaction([ownerKeyPair, partnerKeyPair], transaction);

    const result = await submitExternalQueuedWithdrawalAction(env, {
      actor: {
        organizationId: ORG,
        projectId: PROJECT,
        environment: "sandbox",
        userId: USER,
        apiKeyId: null,
      },
      transactionId: built.id,
      signedTransaction: Buffer.from(getTransactionEncoder().encode(signed)).toString("base64"),
      clientRequestId: "queued-output-rent-key",
      action: "request",
    });

    expect(result.replayed).toBe(false);
    await expect(requestRow(result.request.id)).resolves.toEqual({
      creates_output_accounts: true,
      output_accounts_rent_funder: partnerAddress,
    });
  });
});
