import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { generateEarnPositionId } from "@/db/repositories/earn-movements.repository";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type { VaultWithdrawalInput } from "./vault-withdraw.service";

const buildVaultWithdrawal = vi.hoisted(() => vi.fn());
const signVaultPlanTransactions = vi.hoisted(() => vi.fn());
const broadcastVaultTransaction = vi.hoisted(() => vi.fn());
const simulateVaultPlan = vi.hoisted(() => vi.fn());
const createOrgSignerForCustodyWallet = vi.hoisted(() => vi.fn());
const resolveVaultWithdrawClient = vi.hoisted(() => vi.fn());
const getSignatureStatuses = vi.hoisted(() => vi.fn());

vi.mock("./execution-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./execution-registry")>()),
  resolveVaultWithdrawClient,
  resolveClusterRpcUrl: () => "https://rpc.example.invalid",
}));

vi.mock("./vault-execution.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./vault-execution.service")>()),
  signVaultPlanTransactions,
  broadcastVaultTransaction,
  simulateVaultPlan,
}));

vi.mock("@/services/solana", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/solana")>()),
  createOrgSignerForCustodyWallet,
}));

vi.mock("@sdp/rpc/solana", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sdp/rpc/solana")>()),
  getSignatureStatuses,
}));

const { withdrawFromVault } = await import("./vault-withdraw.service");

const ORG = "org_vault_withdraw";
const PROJECT = "prj_vault_withdraw";
const USER = "usr_vault_withdraw";
const WALLET_ROW_ID = "cwlt_vault_withdraw";
const CUSTODY_CONFIG_ID = "cfg_vault_withdraw";
const WALLET_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const TOKEN_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SHARE_MINT = "So11111111111111111111111111111111111111112";
const VAULT = "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx";

const wallet = { id: WALLET_ROW_ID, walletId: "privy_vault_withdraw", publicKey: WALLET_ADDRESS };

let positionId: string;

function withdrawalInput(overrides: Partial<VaultWithdrawalInput> = {}): VaultWithdrawalInput {
  return {
    organizationId: ORG,
    projectId: PROJECT,
    environment: "sandbox" as const,
    provider: "kamino",
    positionId,
    vaultAddress: VAULT,
    tokenMint: TOKEN_MINT,
    shareMint: SHARE_MINT,
    wallet,
    shares: "10",
    requestId: "11111111-1111-4111-8111-111111111111",
    userId: USER,
    apiKeyId: null,
    ...overrides,
  };
}

const instruction = { programAddress: "11111111111111111111111111111111", accounts: [], data: "" };

function plan(overrides: Record<string, unknown> = {}) {
  return {
    cluster: "devnet",
    transactions: [[instruction]],
    lookupTables: [],
    transactionShares: ["10"],
    assetIdentity: { depositTokenMint: TOKEN_MINT, shareMint: SHARE_MINT },
    accepted: { shares: "10" },
    ...overrides,
  };
}

function multiLegPlan() {
  return plan({
    transactions: [[instruction], [instruction]],
    transactionShares: ["6", "4"],
  });
}

function signedLegs(count: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    bytes: new Uint8Array([index + 1]),
    signature: `sig_withdraw_leg_${index}`,
    lastValidBlockHeight: "12345",
  }));
}

const confirmedStatus = { confirmationStatus: "confirmed", err: null };

async function seedWalletAndPosition(): Promise<void> {
  positionId = generateEarnPositionId();
  await getDb(env).batch([
    getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORG, "Vault Withdraw Org", "vault-withdraw", "enterprise", "active"),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(USER, "vault-withdraw@example.com", 1, "active"),
    getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, 'sandbox', 'active', ?)`
      )
      .bind(PROJECT, ORG, "Vault Withdraw Project", "vault-withdraw-project", USER),
    getDb(env)
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES (?, ?, ?, 'privy', 'test-encrypted', 'active')`
      )
      .bind(CUSTODY_CONFIG_ID, ORG, PROJECT),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, ?, ?, ?, 'active')`
      )
      .bind(WALLET_ROW_ID, CUSTODY_CONFIG_ID, wallet.walletId, WALLET_ADDRESS),
    // The EXISTING holding an exit is asked of — the service never creates one.
    getDb(env)
      .prepare(
        `INSERT INTO earn_positions (
           id, organization_id, project_id, environment, provider, kind,
           custody_wallet_id, vault_address, share_mint, token_mint, label, activated_at
         ) VALUES (?, ?, ?, 'sandbox', 'kamino', 'vault_direct', ?, ?, ?, ?, ?, sdp_iso_now())`
      )
      .bind(positionId, ORG, PROJECT, WALLET_ROW_ID, VAULT, SHARE_MINT, TOKEN_MINT, "Test Vault"),
  ]);
}

async function movementRows() {
  const result = await getDb(env)
    .prepare(
      `SELECT id, status, leg_group_id, leg_index, leg_count, denomination,
              amount_requested, signature, request_id, failure_reason,
              source_address, destination_address
         FROM earn_movements
        ORDER BY leg_index ASC`
    )
    .all<Record<string, unknown>>();
  return result.results ?? [];
}

beforeEach(async () => {
  await seedTestDatabase(env);
  await seedWalletAndPosition();
  vi.clearAllMocks();
  resolveVaultWithdrawClient.mockReturnValue({ buildVaultWithdrawal });
  buildVaultWithdrawal.mockResolvedValue(plan());
  simulateVaultPlan.mockResolvedValue({ ok: true });
  createOrgSignerForCustodyWallet.mockResolvedValue({ address: WALLET_ADDRESS });
  signVaultPlanTransactions.mockResolvedValue(signedLegs(1));
  broadcastVaultTransaction.mockResolvedValue(undefined);
  getSignatureStatuses.mockResolvedValue([confirmedStatus]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("withdrawFromVault — idempotency", () => {
  it("replays the original vault withdrawal for the same requestId and payload", async () => {
    const first = await withdrawFromVault(env, withdrawalInput());
    const second = await withdrawFromVault(env, withdrawalInput());

    expect(second).toMatchObject({ replayed: true });
    expect(second.movements.map((leg) => leg.id)).toEqual(first.movements.map((leg) => leg.id));
    expect(second.position.id).toBe(positionId);
    expect(signVaultPlanTransactions).toHaveBeenCalledTimes(1);
    expect(broadcastVaultTransaction).toHaveBeenCalledTimes(1);
  });

  it("serves a durable replay without proving or touching the RPC endpoint", async () => {
    await withdrawFromVault(env, withdrawalInput());
    vi.clearAllMocks();

    const replay = await withdrawFromVault(env, withdrawalInput());

    expect(replay.replayed).toBe(true);
    expect(resolveVaultWithdrawClient).not.toHaveBeenCalled();
    expect(buildVaultWithdrawal).not.toHaveBeenCalled();
    expect(signVaultPlanTransactions).not.toHaveBeenCalled();
  });

  it("rejects the same requestId with a different payload", async () => {
    await withdrawFromVault(env, withdrawalInput());
    await expect(withdrawFromVault(env, withdrawalInput({ shares: "5" }))).rejects.toMatchObject({
      code: "CONFLICT",
    });

    expect(await movementRows()).toHaveLength(1);
  });

  it("replays every leg of a multi-transaction group", async () => {
    buildVaultWithdrawal.mockResolvedValue(multiLegPlan());
    signVaultPlanTransactions.mockResolvedValue(signedLegs(2));

    const first = await withdrawFromVault(env, withdrawalInput());
    expect(first.movements).toHaveLength(2);
    vi.clearAllMocks();

    const replay = await withdrawFromVault(env, withdrawalInput());
    expect(replay.replayed).toBe(true);
    expect(replay.movements.map((leg) => leg.leg_index)).toEqual([0, 1]);
    expect(broadcastVaultTransaction).not.toHaveBeenCalled();
  });

  it("conflicts a sibling project's identical key on the fast replay path, before signing", async () => {
    const siblingProject = "prj_vault_withdraw_sibling";
    await getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Sibling Withdraw Project', 'sibling-withdraw-project', 'sandbox', 'active', ?)`
      )
      .bind(siblingProject, ORG, USER)
      .run();

    const first = await withdrawFromVault(env, withdrawalInput());
    expect(first.replayed).toBe(false);
    const signingsAfterFirst = signVaultPlanTransactions.mock.calls.length;

    await expect(
      withdrawFromVault(env, withdrawalInput({ projectId: siblingProject }))
    ).rejects.toThrow("Idempotency key already used with different request payload");
    expect(signVaultPlanTransactions.mock.calls.length).toBe(signingsAfterFirst);
  });
});

describe("withdrawFromVault — recording and submission", () => {
  it("records every leg with its exact shares, share-mint denomination, and leg identity", async () => {
    buildVaultWithdrawal.mockResolvedValue(multiLegPlan());
    signVaultPlanTransactions.mockResolvedValue(signedLegs(2));

    const result = await withdrawFromVault(env, withdrawalInput());
    const rows = await movementRows();

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.leg_index)).toEqual([0, 1]);
    expect(new Set(rows.map((row) => row.leg_group_id)).size).toBe(1);
    expect(rows.map((row) => row.leg_count)).toEqual([2, 2]);
    expect(rows.map((row) => row.amount_requested)).toEqual(["6", "4"]);
    expect(rows.every((row) => row.denomination === SHARE_MINT)).toBe(true);
    // Money leaves the instrument and returns to the org's own wallet.
    expect(rows.every((row) => row.source_address === VAULT)).toBe(true);
    expect(rows.every((row) => row.destination_address === WALLET_ADDRESS)).toBe(true);
    // Leg 0 anchors the caller's key; leg 1 derives with the newline rule.
    expect(rows[0].request_id).toBe(withdrawalInput().requestId);
    expect(rows[1].request_id).toBe(`${withdrawalInput().requestId}\nleg:1`);
    expect(result.movements.map((leg) => leg.signature)).toEqual([
      "sig_withdraw_leg_0",
      "sig_withdraw_leg_1",
    ]);
  });

  it("records every leg BEFORE the first broadcast", async () => {
    buildVaultWithdrawal.mockResolvedValue(multiLegPlan());
    signVaultPlanTransactions.mockResolvedValue(signedLegs(2));
    let rowsAtFirstBroadcast = -1;
    broadcastVaultTransaction.mockImplementation(async () => {
      if (rowsAtFirstBroadcast === -1) {
        rowsAtFirstBroadcast = (await movementRows()).length;
      }
    });

    await withdrawFromVault(env, withdrawalInput());

    expect(rowsAtFirstBroadcast).toBe(2);
  });

  it("submits a single-leg withdrawal without waiting for commitment", async () => {
    const result = await withdrawFromVault(env, withdrawalInput());

    expect(result.movements).toHaveLength(1);
    expect(result.movements[0].status).toBe("submitted");
    expect(broadcastVaultTransaction).toHaveBeenCalledTimes(1);
    // The sweep settles the last leg; the request never polls for it.
    expect(getSignatureStatuses).not.toHaveBeenCalled();
  });

  it("broadcasts legs in order, gating each on its predecessor's commitment", async () => {
    buildVaultWithdrawal.mockResolvedValue(multiLegPlan());
    signVaultPlanTransactions.mockResolvedValue(signedLegs(2));
    const broadcastOrder: number[] = [];
    broadcastVaultTransaction.mockImplementation(async (_env, { bytes }) => {
      broadcastOrder.push(bytes[0]);
      // Leg 2 may only be broadcast after leg 1's commitment was observed.
      if (bytes[0] === 2) {
        expect(getSignatureStatuses).toHaveBeenCalled();
      }
    });

    const result = await withdrawFromVault(env, withdrawalInput());

    expect(broadcastOrder).toEqual([1, 2]);
    expect(result.movements[0].status).toBe("confirmed");
    expect(result.movements[0].confirmed_at).toBeTruthy();
    expect(result.movements[1].status).toBe("submitted");
  });

  it("stops after an ambiguous broadcast and leaves later legs for the sweep", async () => {
    buildVaultWithdrawal.mockResolvedValue(multiLegPlan());
    signVaultPlanTransactions.mockResolvedValue(signedLegs(2));
    broadcastVaultTransaction.mockRejectedValueOnce(new Error("ambiguous broadcast"));

    const result = await withdrawFromVault(env, withdrawalInput());

    expect(broadcastVaultTransaction).toHaveBeenCalledTimes(1);
    // Both legs remain reconcilable by signature: the first may have landed,
    // the second must not be sent until the first's fate is known.
    expect(result.movements.map((leg) => leg.status)).toEqual(["requested", "requested"]);
    expect(getSignatureStatuses).not.toHaveBeenCalled();
  });

  it("fails the remaining legs when a leg lands with an execution error", async () => {
    buildVaultWithdrawal.mockResolvedValue(multiLegPlan());
    signVaultPlanTransactions.mockResolvedValue(signedLegs(2));
    getSignatureStatuses.mockResolvedValue([
      { confirmationStatus: "processed", err: { InstructionError: [0, "Custom"] } },
    ]);

    const result = await withdrawFromVault(env, withdrawalInput());

    expect(broadcastVaultTransaction).toHaveBeenCalledTimes(1);
    expect(result.movements[0].status).toBe("failed");
    expect(result.movements[0].failure_reason).toContain("InstructionError");
    expect(result.movements[1].status).toBe("failed");
    expect(result.movements[1].failure_reason).toContain("Predecessor withdrawal leg");
  });

  it("returns with legs pending when the commitment wait exhausts the budget", async () => {
    buildVaultWithdrawal.mockResolvedValue(multiLegPlan());
    signVaultPlanTransactions.mockResolvedValue(signedLegs(2));
    // Never confirms within the request: the poll sees "processed" forever.
    getSignatureStatuses.mockRejectedValue(new Error("Confirming timed out"));

    const result = await withdrawFromVault(env, withdrawalInput());

    expect(broadcastVaultTransaction).toHaveBeenCalledTimes(1);
    expect(result.movements[0].status).toBe("submitted");
    expect(result.movements[1].status).toBe("requested");
  });
});

describe("withdrawFromVault — plan validation and gates", () => {
  it("answers NOT_IMPLEMENTED when the provider lacks the withdraw capability", async () => {
    resolveVaultWithdrawClient.mockReturnValue(null);
    await expect(withdrawFromVault(env, withdrawalInput())).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
    });
    expect(await movementRows()).toHaveLength(0);
  });

  it("refuses a plan whose asset identity does not match the position", async () => {
    buildVaultWithdrawal.mockResolvedValue(
      plan({ assetIdentity: { depositTokenMint: SHARE_MINT, shareMint: SHARE_MINT } })
    );
    await expect(withdrawFromVault(env, withdrawalInput())).rejects.toThrow(
      /does not match the position/
    );
    expect(signVaultPlanTransactions).not.toHaveBeenCalled();
  });

  it("refuses a plan whose encoded shares differ from the request", async () => {
    buildVaultWithdrawal.mockResolvedValue(plan({ accepted: { shares: "9" } }));
    await expect(withdrawFromVault(env, withdrawalInput())).rejects.toThrow(
      /shares do not match the requested withdrawal/
    );
  });

  it("refuses a plan missing its per-transaction share quantities", async () => {
    buildVaultWithdrawal.mockResolvedValue(plan({ transactionShares: undefined }));
    await expect(withdrawFromVault(env, withdrawalInput())).rejects.toThrow(
      /per-transaction share quantities/
    );
  });

  it("surfaces a failed simulation as a bad request and signs nothing", async () => {
    simulateVaultPlan.mockResolvedValue({ ok: false, error: "program error", logs: [] });
    await expect(withdrawFromVault(env, withdrawalInput())).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(signVaultPlanTransactions).not.toHaveBeenCalled();
    expect(await movementRows()).toHaveLength(0);
  });

  it("stamps the withdrawal memo onto every transaction of the plan", async () => {
    buildVaultWithdrawal.mockResolvedValue(multiLegPlan());
    signVaultPlanTransactions.mockImplementation(async (_env, input) => {
      for (const batch of input.plan.transactions) {
        const memo = Buffer.from(batch.at(-1)?.data ?? "", "base64").toString("utf8");
        expect(memo).toBe(`sdp:earn:vault-withdrawal:${withdrawalInput().requestId}`);
      }
      return signedLegs(input.plan.transactions.length);
    });

    await withdrawFromVault(env, withdrawalInput());
    expect(signVaultPlanTransactions).toHaveBeenCalledTimes(1);
  });

  it("refuses an exit against a position the organization does not hold", async () => {
    await expect(
      withdrawFromVault(env, withdrawalInput({ positionId: generateEarnPositionId() }))
    ).rejects.toThrow();
    expect(broadcastVaultTransaction).not.toHaveBeenCalled();
    expect(await movementRows()).toHaveLength(0);
  });
});
