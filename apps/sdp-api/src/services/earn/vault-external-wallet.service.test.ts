import { SdpVedaError } from "@sdp/veda";
import type { Blockhash } from "@solana/kit";
import {
  AccountRole,
  generateKeyPair,
  getAddressFromPublicKey,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransaction,
} from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import type { EarnExternalWalletTransactionRow } from "@/db/repositories/earn-external-wallet-transactions.repository";
import { generateEarnPositionId } from "@/db/repositories/earn-movements.repository";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type {
  ExternalWalletDepositBuildInput,
  ExternalWalletWithdrawalBuildInput,
} from "./vault-external-wallet.service";

const buildVaultDeposit = vi.hoisted(() => vi.fn());
const buildVaultWithdrawal = vi.hoisted(() => vi.fn());
const resolveVaultDirectClient = vi.hoisted(() => vi.fn());
const resolveVaultWithdrawClient = vi.hoisted(() => vi.fn());
const simulateVaultPlan = vi.hoisted(() => vi.fn());
const broadcastVaultTransaction = vi.hoisted(() => vi.fn());
const fetchJupiterSwapLeg = vi.hoisted(() => vi.fn());

// `prependSwapLegToVaultPlan` stays REAL — instruction ordering is part of
// what the swap-funded cases prove. Only the Jupiter HTTP boundary is stubbed.
vi.mock("./jupiter-swap.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./jupiter-swap.service")>()),
  fetchJupiterSwapLeg,
}));

vi.mock("./execution-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./execution-registry")>()),
  resolveVaultDirectClient,
  resolveVaultWithdrawClient,
  resolveClusterRpcUrl: () => "https://rpc.example.invalid",
}));

// `appendVaultRequestMemo` and `compileUnsignedVaultTransaction` stay REAL:
// the whole point of these tests is that the service hands out genuinely
// signable bytes and verifies genuine ed25519 signatures over them. Only the
// RPC-touching stages are stubbed.
vi.mock("./vault-execution.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./vault-execution.service")>()),
  simulateVaultPlan,
  broadcastVaultTransaction,
}));

const {
  buildExternalWalletDepositTransaction,
  buildExternalWalletWithdrawalTransaction,
  submitExternalWalletDeposit,
  submitExternalWalletWithdrawal,
} = await import("./vault-external-wallet.service");

/**
 * The external-wallet (caller-signed) flows, end to end minus the chain
 * (PRO-1722): build persists an unsigned transaction, submit verifies a real
 * signature over exactly those bytes, records the movement before broadcast,
 * and answers retries from the ledger.
 *
 * The owner is a REAL keypair generated per run: the signature-verification
 * cases (missing, forged, wrong message) are only proof if the happy path's
 * signature is genuine.
 */

const ORG = "org_ext_wallet";
const PROJECT = "prj_ext_wallet";
const SIBLING_PROJECT = "prj_ext_wallet_sibling";
const USER = "usr_ext_wallet";
const TOKEN_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SHARE_MINT = "So11111111111111111111111111111111111111112";
const VAULT = "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx";
// 32 base58 ones decode to 32 zero bytes — a structurally valid blockhash.
const BLOCKHASH = "11111111111111111111111111111111" as Blockhash;

const MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

let ownerKeyPair: CryptoKeyPair;
let ownerAddress: string;

function providerInstruction() {
  return {
    programAddress: MEMO_PROGRAM_ADDRESS,
    accounts: [],
    data: Buffer.from("provider-instruction", "utf8").toString("base64"),
  };
}

function depositPlan(overrides: Record<string, unknown> = {}) {
  return {
    cluster: "devnet",
    instructions: [providerInstruction()],
    lookupTables: [],
    assetIdentity: { depositTokenMint: TOKEN_MINT, shareMint: SHARE_MINT },
    accepted: { amount: "25" },
    createsShareAccount: true,
    ...overrides,
  };
}

function withdrawalPlan(overrides: Record<string, unknown> = {}) {
  return {
    cluster: "devnet",
    instructions: [providerInstruction()],
    lookupTables: [],
    assetIdentity: { depositTokenMint: TOKEN_MINT, shareMint: SHARE_MINT },
    accepted: { shares: "10" },
    ...overrides,
  };
}

function depositInput(
  overrides: Partial<ExternalWalletDepositBuildInput> = {}
): ExternalWalletDepositBuildInput {
  return {
    organizationId: ORG,
    projectId: PROJECT,
    environment: "sandbox",
    provider: "kamino",
    providerReference: VAULT,
    ownerAddress,
    tokenMint: TOKEN_MINT,
    shareMint: SHARE_MINT,
    label: "Test USDC Vault",
    amount: "25",
    userId: USER,
    ...overrides,
  };
}

async function seedTenancy(): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORG, "External Wallet Org", "ext-wallet", "enterprise", "active"),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(USER, "ext-wallet@example.com"),
    db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Test Project', 'ext-wallet-project', 'sandbox', 'active', ?)`
      )
      .bind(PROJECT, ORG, USER),
    db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Sibling Project', 'ext-wallet-sibling', 'sandbox', 'active', ?)`
      )
      .bind(SIBLING_PROJECT, ORG, USER),
  ]);
}

async function seedExternalWalletPosition(
  overrides: Partial<{ projectId: string; ownerAddress: string }> = {}
): Promise<string> {
  const id = generateEarnPositionId();
  await getDb(env)
    .prepare(
      `INSERT INTO earn_positions (
         id, organization_id, project_id, environment, provider, kind,
         owner_address, vault_address, share_mint, token_mint, label, activated_at
       ) VALUES (?, ?, ?, 'sandbox', 'kamino', 'vault_direct', ?, ?, ?, ?, 'Exit Vault', sdp_iso_now())`
    )
    .bind(
      id,
      ORG,
      overrides.projectId ?? PROJECT,
      overrides.ownerAddress ?? ownerAddress,
      VAULT,
      SHARE_MINT,
      TOKEN_MINT
    )
    .run();
  return id;
}

function withdrawalInput(
  positionId: string,
  overrides: Partial<ExternalWalletWithdrawalBuildInput> = {}
): ExternalWalletWithdrawalBuildInput {
  return {
    organizationId: ORG,
    projectId: PROJECT,
    environment: "sandbox",
    provider: "kamino",
    positionId,
    vaultAddress: VAULT,
    tokenMint: TOKEN_MINT,
    shareMint: SHARE_MINT,
    ownerAddress,
    label: "Exit Vault",
    shareAtaRentFunder: null,
    shares: "10",
    userId: USER,
    ...overrides,
  };
}

/** Unwrap the atomic build answer; swap-split cases assert on the union directly. */
async function buildDepositRow(
  input: ExternalWalletDepositBuildInput
): Promise<EarnExternalWalletTransactionRow> {
  const result = await buildExternalWalletDepositTransaction(env, input);
  if (result.kind !== "built") {
    throw new Error(`expected a built transaction, got ${result.kind}`);
  }
  return result.built;
}

async function signBuiltTransaction(
  built: EarnExternalWalletTransactionRow,
  keyPair: CryptoKeyPair = ownerKeyPair
): Promise<string> {
  const transaction = getTransactionDecoder().decode(
    Uint8Array.from(Buffer.from(built.unsigned_transaction, "base64"))
  );
  const signed = await partiallySignTransaction([keyPair], transaction);
  return Buffer.from(getTransactionEncoder().encode(signed)).toString("base64");
}

function submitDeposit(
  built: EarnExternalWalletTransactionRow,
  signedTransaction: string,
  requestId: string,
  overrides: Partial<Parameters<typeof submitExternalWalletDeposit>[1]> = {}
) {
  return submitExternalWalletDeposit(env, {
    organizationId: ORG,
    projectId: PROJECT,
    environment: "sandbox",
    transactionId: built.id,
    signedTransaction,
    requestId,
    userId: USER,
    ...overrides,
  });
}

beforeEach(async () => {
  await seedTestDatabase(env);
  await seedTenancy();
  vi.clearAllMocks();

  ownerKeyPair = await generateKeyPair();
  ownerAddress = await getAddressFromPublicKey(ownerKeyPair.publicKey);

  resolveVaultDirectClient.mockReturnValue({ buildVaultDeposit });
  resolveVaultWithdrawClient.mockReturnValue({ buildVaultWithdrawal });
  buildVaultDeposit.mockResolvedValue(depositPlan());
  buildVaultWithdrawal.mockResolvedValue(withdrawalPlan());
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
});

describe("buildExternalWalletDepositTransaction", () => {
  it("persists and returns a decodable unsigned transaction for the owner", async () => {
    const built = await buildDepositRow(depositInput());

    expect(built.direction).toBe("deposit");
    expect(built.owner_address).toBe(ownerAddress);
    expect(built.vault_address).toBe(VAULT);
    expect(built.denomination).toBe(TOKEN_MINT);
    expect(built.amount_requested).toBe("25");
    expect(built.creates_share_account).toBe(true);
    expect(built.last_valid_block_height).toBe("361");
    expect(built.movement_id).toBeNull();

    const decoded = getTransactionDecoder().decode(
      Uint8Array.from(Buffer.from(built.unsigned_transaction, "base64"))
    );
    // The owner is the fee payer and the only required signer, still unsigned.
    expect(Object.keys(decoded.signatures)).toEqual([ownerAddress]);
    expect(decoded.signatures[ownerAddress as keyof typeof decoded.signatures]).toBeNull();

    // Simulated with the owner paying its own fee — the shape it will sign.
    expect(simulateVaultPlan).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ owner: ownerAddress, fee: { kind: "wallet-pays" } })
    );
    // The provider build was NOT asked to name a separate rent payer.
    expect(buildVaultDeposit.mock.calls[0][1]).not.toHaveProperty("rentPayer");
  });

  it("answers 501 when the provider has no vault-direct capability", async () => {
    resolveVaultDirectClient.mockReturnValue(null);
    await expect(buildExternalWalletDepositTransaction(env, depositInput())).rejects.toThrowError(
      /direct vault deposits/
    );
  });

  it("maps shared provider refusals to a caller-facing bad request", async () => {
    buildVaultDeposit.mockRejectedValue(
      new SdpVedaError("INVALID_AMOUNT", "Veda deposits require minSharesOut")
    );

    await expect(buildExternalWalletDepositTransaction(env, depositInput())).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Veda deposits require minSharesOut",
    });
  });

  it("refuses a failed simulation before persisting anything", async () => {
    simulateVaultPlan.mockResolvedValue({ ok: false, error: "InstructionError", logs: [] });
    await expect(buildExternalWalletDepositTransaction(env, depositInput())).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    const row = await getDb(env)
      .prepare("SELECT COUNT(*)::int AS builds FROM earn_external_wallet_transactions")
      .first<{ builds: number }>();
    expect(row?.builds).toBe(0);
  });
});

describe("buildExternalWalletDepositTransaction (swap-funded)", () => {
  // Devnet USDG — any pinned mint works; the route validates membership, the
  // service only carries it to the (stubbed) Jupiter boundary.
  const SOURCE_MINT = "4F6PM96JJxngmHnZLBh9n58RH4aTVNWvDs2nuwrT5BP7";

  function swapLeg(overrides: Record<string, unknown> = {}) {
    return {
      instructions: [
        {
          programAddress: MEMO_PROGRAM_ADDRESS,
          accounts: [],
          data: Buffer.from("swap-leg", "utf8").toString("base64"),
        },
      ],
      lookupTableAddresses: [],
      sourceAmount: "25",
      quotedAmount: "24.99",
      minOutAmount: "24.8",
      priceImpactPct: "0.0001",
      routeLabels: ["Whirlpool"],
      slippageBps: 50,
      ...overrides,
    };
  }

  function swapDepositInput() {
    return depositInput({
      amount: "25",
      swap: { sourceTokenMint: SOURCE_MINT, slippageBps: 50 },
    });
  }

  it("prepends the swap, sizes the deposit to the floor, and pins a probed CU limit", async () => {
    fetchJupiterSwapLeg.mockResolvedValue(swapLeg());
    buildVaultDeposit.mockResolvedValue(depositPlan({ accepted: { amount: "24.8" } }));
    simulateVaultPlan.mockImplementation(async (_env, input) => ({
      ok: true,
      prepared: {
        plan: input.plan,
        lookupTables: {},
        blockhash: BLOCKHASH,
        lastValidBlockHeight: 361n,
      },
      unitsConsumed: 400_000n,
    }));

    const result = await buildExternalWalletDepositTransaction(env, swapDepositInput());

    // The provider built for the FLOOR, not the request's source amount.
    expect(buildVaultDeposit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ amount: "24.8" })
    );
    expect(fetchJupiterSwapLeg).toHaveBeenCalledWith(
      env,
      expect.anything(),
      expect.objectContaining({
        inputMint: SOURCE_MINT,
        outputMint: TOKEN_MINT,
        sourceAmount: "25",
        owner: ownerAddress,
        slippageBps: 50,
      })
    );

    if (result.kind !== "built") throw new Error(`expected built, got ${result.kind}`);
    // The persisted amount is the DEPOSIT amount in the deposit token, so the
    // row's denomination stays truthful.
    expect(result.built.amount_requested).toBe("24.8");
    expect(result.built.denomination).toBe(TOKEN_MINT);
    expect(result.swap?.minOutAmount).toBe("24.8");

    // TWO simulations: a probe under the MAXIMUM compute-unit limit, then the
    // final plan under the buffered consumption — Jupiter's /build carries no
    // CU limit, so it is derived locally (see jupiter-swap.service.ts).
    expect(simulateVaultPlan).toHaveBeenCalledTimes(2);
    const probe = simulateVaultPlan.mock.calls[0]?.[1]?.plan;
    const probeCu = Buffer.from(probe.instructions[0].data, "base64");
    expect(probe.instructions[0].programAddress).toBe(
      "ComputeBudget111111111111111111111111111111"
    );
    expect(probeCu.readUInt32LE(1)).toBe(1_400_000);

    // Final (compiled) plan order: locally built CU limit — buffered 15% over
    // the probe's consumption — then swap leg, provider deposit, memo last.
    const simulated = simulateVaultPlan.mock.calls[1]?.[1]?.plan;
    const finalCu = Buffer.from(simulated.instructions[0].data, "base64");
    expect(finalCu.readUInt8(0)).toBe(2);
    expect(finalCu.readUInt32LE(1)).toBe(460_001);
    const datas = simulated.instructions
      .slice(1)
      .map((instruction: { data: string }) =>
        Buffer.from(instruction.data, "base64").toString("utf8")
      );
    expect(datas[0]).toBe("swap-leg");
    expect(datas[1]).toBe("provider-instruction");
    expect(datas[2]).toMatch(/^sdp:earn:external-deposit:/);
  });

  it("splits into a standalone swap when the composed transaction cannot fit, persisting nothing", async () => {
    fetchJupiterSwapLeg.mockResolvedValue(swapLeg());
    // A provider plan too bulky to share a packet with anything: the composed
    // compile overflows on both route widths, the swap alone still fits.
    buildVaultDeposit.mockResolvedValue(
      depositPlan({
        accepted: { amount: "24.8" },
        instructions: [
          {
            programAddress: MEMO_PROGRAM_ADDRESS,
            accounts: [],
            data: Buffer.alloc(1300).toString("base64"),
          },
        ],
      })
    );

    const result = await buildExternalWalletDepositTransaction(env, swapDepositInput());

    // One re-route for compactness before giving up on atomicity.
    expect(fetchJupiterSwapLeg).toHaveBeenCalledTimes(2);
    expect(fetchJupiterSwapLeg.mock.calls[1]?.[2]).toMatchObject({ maxAccounts: 24 });

    if (result.kind !== "swap_required")
      throw new Error(`expected swap_required, got ${result.kind}`);
    expect(result.swap.minOutAmount).toBe("24.8");
    // The standalone swap is genuinely compilable owner-signed bytes.
    const decoded = getTransactionDecoder().decode(result.swapTransaction.bytes);
    expect(Object.keys(decoded.signatures)).toEqual([ownerAddress]);

    // Nothing durable: the split answer hands out no consumable build.
    const row = await getDb(env)
      .prepare("SELECT COUNT(*)::int AS builds FROM earn_external_wallet_transactions")
      .first<{ builds: number }>();
    expect(row?.builds).toBe(0);
  });

  it("keeps an unswapped oversized provider plan a loud failure, not a split", async () => {
    buildVaultDeposit.mockResolvedValue(
      depositPlan({
        instructions: [
          {
            programAddress: MEMO_PROGRAM_ADDRESS,
            accounts: [],
            data: Buffer.alloc(1300).toString("base64"),
          },
        ],
      })
    );

    await expect(buildExternalWalletDepositTransaction(env, depositInput())).rejects.toThrowError(
      /Solana allows at most/
    );
    expect(fetchJupiterSwapLeg).not.toHaveBeenCalled();
  });
});

describe("submitExternalWalletDeposit", () => {
  it("verifies the owner signature, records before broadcast, and claims the position", async () => {
    const built = await buildDepositRow(depositInput());
    const signed = await signBuiltTransaction(built);
    const requestId = crypto.randomUUID();

    const result = await submitDeposit(built, signed, requestId);

    expect(result.replayed).toBe(false);
    expect(result.movement.status).toBe("submitted");
    expect(result.movement.direction).toBe("deposit");
    expect(result.movement.owner_address).toBe(ownerAddress);
    expect(result.movement.custody_wallet_id).toBeNull();
    expect(result.movement.source_address).toBe(ownerAddress);
    expect(result.movement.destination_address).toBe(VAULT);
    expect(result.movement.denomination).toBe(TOKEN_MINT);
    expect(result.movement.request_id).toBe(requestId);
    // The owner funded its own share-account rent: recorded as the NULL funder
    // so the exit's refund defaults back to the owner.
    expect(result.movement.creates_share_account).toBe(true);
    expect(result.movement.share_ata_rent_funder).toBeNull();

    expect(result.position.owner_address).toBe(ownerAddress);
    expect(result.position.custody_wallet_id).toBeNull();
    expect(result.position.project_id).toBe(PROJECT);
    expect(result.position.activated_at).not.toBeNull();

    // The signed bytes that were broadcast are the recorded outbox bytes.
    expect(broadcastVaultTransaction).toHaveBeenCalledTimes(1);
    expect(Buffer.from(broadcastVaultTransaction.mock.calls[0][1].bytes).toString("base64")).toBe(
      result.movement.signed_transaction
    );

    // The build is consumed by exactly this movement.
    const consumed = await getDb(env)
      .prepare("SELECT movement_id FROM earn_external_wallet_transactions WHERE id = ?")
      .bind(built.id)
      .first<{ movement_id: string | null }>();
    expect(consumed?.movement_id).toBe(result.movement.id);
  });

  it("replays the original movement for the same key without re-broadcasting", async () => {
    const built = await buildDepositRow(depositInput());
    const signed = await signBuiltTransaction(built);
    const requestId = crypto.randomUUID();

    const first = await submitDeposit(built, signed, requestId);
    const replay = await submitDeposit(built, signed, requestId);

    expect(replay.replayed).toBe(true);
    expect(replay.movement.id).toBe(first.movement.id);
    expect(broadcastVaultTransaction).toHaveBeenCalledTimes(1);
  });

  it("rejects the same key used for a different build", async () => {
    const first = await buildDepositRow(depositInput());
    const second = await buildDepositRow(depositInput());
    const requestId = crypto.randomUUID();

    await submitDeposit(first, await signBuiltTransaction(first), requestId);
    await expect(
      submitDeposit(second, await signBuiltTransaction(second), requestId)
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects a second key against an already-submitted build", async () => {
    const built = await buildDepositRow(depositInput());
    const signed = await signBuiltTransaction(built);

    await submitDeposit(built, signed, crypto.randomUUID());
    await expect(submitDeposit(built, signed, crypto.randomUUID())).rejects.toMatchObject({
      code: "CONFLICT",
    });
    // One built transaction, one movement — the ledger holds no duplicate.
    const rows = await getDb(env)
      .prepare("SELECT COUNT(*)::int AS movements FROM earn_movements")
      .first<{ movements: number }>();
    expect(rows?.movements).toBe(1);
  });

  it("prevents one movement from consuming more than one built transaction", async () => {
    const first = await buildDepositRow(depositInput());
    const second = await buildDepositRow(depositInput());
    const result = await submitDeposit(
      first,
      await signBuiltTransaction(first),
      crypto.randomUUID()
    );

    await expect(
      getDb(env)
        .prepare(
          `UPDATE earn_external_wallet_transactions
           SET movement_id = ?, consumed_at = sdp_iso_now()
           WHERE id = ?`
        )
        .bind(result.movement.id, second.id)
        .run()
    ).rejects.toThrow(/earn_external_wallet_transactions_movement_id_key/i);
  });

  it("rejects signed bytes whose message is not the built transaction", async () => {
    // Two builds of the SAME intent still differ by message: each carries its
    // own transaction id in the memo. Signing build B and submitting it as
    // build A is exactly the substitution the message comparison exists for.
    const built = await buildDepositRow(depositInput());
    const other = await buildDepositRow(depositInput());

    await expect(
      submitDeposit(built, await signBuiltTransaction(other), crypto.randomUUID())
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(broadcastVaultTransaction).not.toHaveBeenCalled();
  });

  it("rejects a submit with no owner signature", async () => {
    const built = await buildDepositRow(depositInput());
    await expect(
      submitDeposit(built, built.unsigned_transaction, crypto.randomUUID())
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects a forged owner signature", async () => {
    const built = await buildDepositRow(depositInput());
    const transaction = getTransactionDecoder().decode(
      Uint8Array.from(Buffer.from(built.unsigned_transaction, "base64"))
    );
    const forged = {
      ...transaction,
      signatures: {
        ...transaction.signatures,
        [ownerAddress]: new Uint8Array(64).fill(7),
      },
      // biome-ignore lint/suspicious/noExplicitAny: deliberately corrupting the branded signature map to prove verification rejects it.
    } as any;
    const bytes = Buffer.from(getTransactionEncoder().encode(forged)).toString("base64");

    await expect(submitDeposit(built, bytes, crypto.randomUUID())).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(broadcastVaultTransaction).not.toHaveBeenCalled();
  });

  it("scopes the build to its exact project", async () => {
    const built = await buildDepositRow(depositInput());
    const signed = await signBuiltTransaction(built);
    await expect(
      submitDeposit(built, signed, crypto.randomUUID(), { projectId: SIBLING_PROJECT })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("enforces the external position's project claim in the database", async () => {
    const built = await buildDepositRow(depositInput());
    const result = await submitDeposit(
      built,
      await signBuiltTransaction(built),
      crypto.randomUUID()
    );

    await expect(
      getDb(env)
        .prepare("UPDATE earn_movements SET project_id = ? WHERE id = ?")
        .bind(SIBLING_PROJECT, result.movement.id)
        .run()
    ).rejects.toThrow(/earn_movements_external_wallet_claim_fkey/i);
  });

  it("preserves external position and movement history after project deletion", async () => {
    const built = await buildDepositRow(depositInput());
    const result = await submitDeposit(
      built,
      await signBuiltTransaction(built),
      crypto.randomUUID()
    );

    await getDb(env).prepare("DELETE FROM projects WHERE id = ?").bind(PROJECT).run();

    const movement = await getDb(env)
      .prepare("SELECT project_id FROM earn_movements WHERE id = ?")
      .bind(result.movement.id)
      .first<{ project_id: string | null }>();
    const position = await getDb(env)
      .prepare("SELECT project_id FROM earn_positions WHERE id = ?")
      .bind(result.position.id)
      .first<{ project_id: string | null }>();

    expect(movement?.project_id).toBeNull();
    expect(position?.project_id).toBeNull();
  });

  it("leaves the movement requested and reconcilable when broadcast fails", async () => {
    broadcastVaultTransaction.mockRejectedValue(new Error("rpc unreachable"));
    const built = await buildDepositRow(depositInput());
    const result = await submitDeposit(
      built,
      await signBuiltTransaction(built),
      crypto.randomUUID()
    );

    expect(result.movement.status).toBe("requested");
    expect(result.movement.signature).not.toBeNull();
    expect(result.movement.signed_transaction).not.toBeNull();
  });
});

describe("partner fee payer (caller-provided)", () => {
  let partnerKeyPair: CryptoKeyPair;
  let partnerAddress: string;

  /**
   * A provider instruction that names the OWNER as a signer, the way every
   * real deposit/exit plan does (the owner's tokens move). This matters here
   * more than anywhere: with the partner in the fee-payer seat, the owner's
   * authorization comes ONLY from instruction-level signer roles.
   */
  function ownerSignerInstruction() {
    return {
      programAddress: MEMO_PROGRAM_ADDRESS,
      accounts: [{ address: ownerAddress, role: AccountRole.READONLY_SIGNER }],
      data: Buffer.from("provider-instruction", "utf8").toString("base64"),
    };
  }

  beforeEach(async () => {
    partnerKeyPair = await generateKeyPair();
    partnerAddress = await getAddressFromPublicKey(partnerKeyPair.publicKey);
    buildVaultDeposit.mockResolvedValue(depositPlan({ instructions: [ownerSignerInstruction()] }));
    buildVaultWithdrawal.mockResolvedValue(
      withdrawalPlan({ instructions: [ownerSignerInstruction()] })
    );
  });

  it("refuses a fee-payer build whose plan does not require the owner's signature", async () => {
    // Without the owner in the fee-payer seat, a plan that never names the
    // owner as a signer would move money on the partner's signature alone —
    // the compile-time signer assertion is what makes that unrepresentable.
    buildVaultDeposit.mockResolvedValue(depositPlan());
    await expect(buildDepositRow(depositInput({ feePayer: partnerAddress }))).rejects.toThrow(
      "must require exactly the fee-payer and owner signatures"
    );
  });

  it("builds a two-signer transaction, funds rent from the partner, and records both facts", async () => {
    const built = await buildDepositRow(depositInput({ feePayer: partnerAddress }));

    expect(built.fee_payer).toBe(partnerAddress);
    // The plan creates the share account and the partner was its rent payer,
    // so the funder is recorded for the exit's refund.
    expect(built.share_ata_rent_funder).toBe(partnerAddress);

    // Slot order is the on-chain contract: fee payer at zero, owner beside it,
    // both unsigned.
    const decoded = getTransactionDecoder().decode(
      Uint8Array.from(Buffer.from(built.unsigned_transaction, "base64"))
    );
    expect(Object.keys(decoded.signatures)).toEqual([partnerAddress, ownerAddress]);
    expect(Object.values(decoded.signatures)).toEqual([null, null]);

    // The funds check ran against the partner wallet, and the provider was
    // asked to charge account rent to the same identity.
    expect(simulateVaultPlan).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        fee: { kind: "caller-provided", feePayer: partnerAddress },
      })
    );
    expect(buildVaultDeposit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ rentPayer: partnerAddress })
    );
  });

  it("records no rent funder when the plan creates no account", async () => {
    buildVaultDeposit.mockResolvedValue(
      depositPlan({ createsShareAccount: false, instructions: [ownerSignerInstruction()] })
    );
    const built = await buildDepositRow(depositInput({ feePayer: partnerAddress }));
    expect(built.fee_payer).toBe(partnerAddress);
    expect(built.share_ata_rent_funder).toBeNull();
  });

  it("treats a fee payer equal to the owner as the default", async () => {
    const built = await buildDepositRow(depositInput({ feePayer: ownerAddress }));
    expect(built.fee_payer).toBeNull();
    expect(built.share_ata_rent_funder).toBeNull();
    const decoded = getTransactionDecoder().decode(
      Uint8Array.from(Buffer.from(built.unsigned_transaction, "base64"))
    );
    expect(Object.keys(decoded.signatures)).toEqual([ownerAddress]);
    expect(simulateVaultPlan).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ fee: { kind: "wallet-pays" } })
    );
  });

  it("accepts a submit signed by both parties and records the fee payer's signature as the txid", async () => {
    const built = await buildDepositRow(depositInput({ feePayer: partnerAddress }));
    const transaction = getTransactionDecoder().decode(
      Uint8Array.from(Buffer.from(built.unsigned_transaction, "base64"))
    );
    const signed = await partiallySignTransaction([ownerKeyPair, partnerKeyPair], transaction);
    const signedBase64 = Buffer.from(getTransactionEncoder().encode(signed)).toString("base64");

    const result = await submitDeposit(built, signedBase64, crypto.randomUUID());

    expect(result.movement.status).toBe("submitted");
    // Slot zero is the partner's signature — the on-chain txid the ledger and
    // the reconciler poll by.
    expect(result.movement.signature).toBe(getSignatureFromTransaction(signed));
    expect(result.movement.creates_share_account).toBe(true);
    expect(result.movement.share_ata_rent_funder).toBe(partnerAddress);
    expect(broadcastVaultTransaction).toHaveBeenCalledTimes(1);

    // The projection carries the funder onto the position, where the exit
    // build reads it as `rentRefundTo`.
    const position = await getDb(env)
      .prepare("SELECT share_ata_rent_funder FROM earn_positions WHERE id = ?")
      .bind(result.position.id)
      .first<{ share_ata_rent_funder: string | null }>();
    expect(position?.share_ata_rent_funder).toBe(partnerAddress);
  });

  it("rejects a submit the fee payer has not co-signed", async () => {
    const built = await buildDepositRow(depositInput({ feePayer: partnerAddress }));
    // Owner-only signature: the partner slot stays null.
    const ownerOnly = await signBuiltTransaction(built);

    await expect(submitDeposit(built, ownerOnly, crypto.randomUUID())).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("fee-payer signature"),
    });
    expect(broadcastVaultTransaction).not.toHaveBeenCalled();
  });

  it("rejects a forged fee-payer signature by name", async () => {
    const built = await buildDepositRow(depositInput({ feePayer: partnerAddress }));
    const transaction = getTransactionDecoder().decode(
      Uint8Array.from(Buffer.from(built.unsigned_transaction, "base64"))
    );
    const ownerSigned = await partiallySignTransaction([ownerKeyPair], transaction);
    const forged = {
      ...ownerSigned,
      signatures: {
        ...ownerSigned.signatures,
        [partnerAddress]: new Uint8Array(64).fill(9),
      },
      // biome-ignore lint/suspicious/noExplicitAny: deliberately corrupting the branded signature map to prove verification rejects it.
    } as any;
    const bytes = Buffer.from(getTransactionEncoder().encode(forged)).toString("base64");

    await expect(submitDeposit(built, bytes, crypto.randomUUID())).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("invalid fee-payer signature"),
    });
    expect(broadcastVaultTransaction).not.toHaveBeenCalled();
  });

  it("builds the exit with the partner paying and refunds the recorded funder", async () => {
    const positionId = await seedExternalWalletPosition();
    const built = await buildExternalWalletWithdrawalTransaction(
      env,
      withdrawalInput(positionId, {
        feePayer: partnerAddress,
        // The deposit recorded the partner as the funder; the exit must refund
        // THAT address, independent of who pays this exit's fee.
        shareAtaRentFunder: partnerAddress,
      })
    );

    expect(built.fee_payer).toBe(partnerAddress);
    expect(buildVaultWithdrawal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ rentPayer: partnerAddress, rentRefundTo: partnerAddress })
    );
    const decoded = getTransactionDecoder().decode(
      Uint8Array.from(Buffer.from(built.unsigned_transaction, "base64"))
    );
    expect(Object.keys(decoded.signatures)).toEqual([partnerAddress, ownerAddress]);
  });
});

describe("external-wallet withdrawals", () => {
  it("builds and submits the exit against the recorded position", async () => {
    const positionId = await seedExternalWalletPosition();
    const built = await buildExternalWalletWithdrawalTransaction(env, withdrawalInput(positionId));
    expect(built.direction).toBe("withdrawal");
    expect(built.position_id).toBe(positionId);
    expect(built.denomination).toBe(SHARE_MINT);
    expect(built.amount_requested).toBe("10");

    const result = await submitExternalWalletWithdrawal(env, {
      organizationId: ORG,
      projectId: PROJECT,
      environment: "sandbox",
      transactionId: built.id,
      signedTransaction: await signBuiltTransaction(built),
      requestId: crypto.randomUUID(),
      userId: USER,
    });

    expect(result.replayed).toBe(false);
    expect(result.movement.direction).toBe("withdrawal");
    expect(result.movement.status).toBe("submitted");
    expect(result.movement.position_id).toBe(positionId);
    expect(result.movement.denomination).toBe(SHARE_MINT);
    // The mirror image of the deposit: out of the instrument, back to the owner.
    expect(result.movement.source_address).toBe(VAULT);
    expect(result.movement.destination_address).toBe(ownerAddress);
    expect(result.movement.owner_address).toBe(ownerAddress);
    expect(result.movement.custody_wallet_id).toBeNull();
  });

  it("carries the caller's withdrawal floor through the shared provider plan", async () => {
    const positionId = await seedExternalWalletPosition();
    buildVaultWithdrawal.mockResolvedValue(
      withdrawalPlan({ accepted: { shares: "10", minAmountOut: "9.5" } })
    );

    const built = await buildExternalWalletWithdrawalTransaction(
      env,
      withdrawalInput(positionId, { minAmountOut: "9.5" })
    );

    expect(buildVaultWithdrawal).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ shares: "10", minAmountOut: "9.5" })
    );
    expect(built.min_shares_out).toBe("9.5");
  });

  it("answers 501 when the provider cannot build an exit", async () => {
    resolveVaultWithdrawClient.mockReturnValue(null);
    const positionId = await seedExternalWalletPosition();
    await expect(
      buildExternalWalletWithdrawalTransaction(env, withdrawalInput(positionId))
    ).rejects.toThrowError(/vault withdrawals/);
  });

  it("maps shared withdrawal refusals to a caller-facing bad request", async () => {
    buildVaultWithdrawal.mockRejectedValue(
      new SdpVedaError("WITHDRAW_REFUSED", "The Veda vault is temporarily paused")
    );
    const positionId = await seedExternalWalletPosition();

    await expect(
      buildExternalWalletWithdrawalTransaction(env, withdrawalInput(positionId))
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "The Veda vault is temporarily paused",
    });
  });

  it("refuses a deposit submit against a withdrawal build", async () => {
    const positionId = await seedExternalWalletPosition();
    const built = await buildExternalWalletWithdrawalTransaction(env, withdrawalInput(positionId));
    await expect(
      submitDeposit(built, await signBuiltTransaction(built), crypto.randomUUID())
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
