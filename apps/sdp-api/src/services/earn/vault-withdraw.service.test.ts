import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { generateEarnPositionId } from "@/db/repositories/earn-movements.repository";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import type { VaultWithdrawalInput } from "./vault-withdraw.service";

const buildVaultWithdrawal = vi.hoisted(() => vi.fn());
const signVaultPlan = vi.hoisted(() => vi.fn());
const broadcastVaultTransaction = vi.hoisted(() => vi.fn());
const simulateVaultPlan = vi.hoisted(() => vi.fn());
const createOrgSignerForCustodyWallet = vi.hoisted(() => vi.fn());
const resolveVaultWithdrawClient = vi.hoisted(() => vi.fn());
const resolveVaultSponsorship = vi.hoisted(() => vi.fn());

vi.mock("./execution-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./execution-registry")>()),
  resolveVaultWithdrawClient,
  resolveClusterRpcUrl: () => "https://rpc.example.invalid",
}));

vi.mock("./vault-execution.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./vault-execution.service")>()),
  signVaultPlan,
  broadcastVaultTransaction,
  simulateVaultPlan,
}));

vi.mock("@/services/solana", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/solana")>()),
  createOrgSignerForCustodyWallet,
}));

// `vaultRentPayer` stays real: it only reads whatever this mock returns.
vi.mock("./vault-sponsorship", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./vault-sponsorship")>()),
  resolveVaultSponsorship,
}));

const { withdrawFromVault } = await import("./vault-withdraw.service");

const ORG = "org_vault_withdraw";
const PROJECT = "prj_vault_withdraw";
const USER = "usr_vault_withdraw";
const WALLET_ROW_ID = "cwlt_vault_withdraw";
const WALLET_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const TOKEN_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SHARE_MINT = "So11111111111111111111111111111111111111112";
const VAULT = "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx";
const SIGNATURE = "sig_vault_withdraw";

let positionId: string;

function input(overrides: Partial<VaultWithdrawalInput> = {}): VaultWithdrawalInput {
  return {
    organizationId: ORG,
    projectId: PROJECT,
    environment: "sandbox",
    provider: "kamino",
    positionId,
    vaultAddress: VAULT,
    tokenMint: TOKEN_MINT,
    shareMint: SHARE_MINT,
    wallet: { id: WALLET_ROW_ID, walletId: "privy_vault_withdraw", publicKey: WALLET_ADDRESS },
    shares: "10",
    requestId: "11111111-1111-4111-8111-111111111111",
    userId: USER,
    ...overrides,
  };
}

const instruction = { programAddress: "11111111111111111111111111111111", accounts: [], data: "" };

function plan(overrides: Record<string, unknown> = {}) {
  return {
    cluster: "devnet",
    instructions: [instruction],
    lookupTables: [],
    assetIdentity: { depositTokenMint: TOKEN_MINT, shareMint: SHARE_MINT },
    accepted: { shares: "10" },
    ...overrides,
  };
}

async function seedPosition(): Promise<void> {
  positionId = generateEarnPositionId();
  const db = getDb(env);
  await db.batch([
    db
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(ORG, "Vault Withdraw Org", "vault-withdraw", "enterprise", "active"),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(USER, "vault-withdraw@example.com", 1, "active"),
    db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, 'sandbox', 'active', ?)`
      )
      .bind(PROJECT, ORG, "Vault Withdraw Project", "vault-withdraw-project", USER),
    db
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, status)
         VALUES ('cfg_vault_withdraw', ?, ?, 'privy', 'test-encrypted', 'active')`
      )
      .bind(ORG, PROJECT),
    db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, status)
         VALUES (?, 'cfg_vault_withdraw', 'privy_vault_withdraw', ?, 'active')`
      )
      .bind(WALLET_ROW_ID, WALLET_ADDRESS),
    db
      .prepare(
        `INSERT INTO earn_positions (
           id, organization_id, project_id, environment, provider, kind,
           custody_wallet_id, vault_address, share_mint, token_mint, label, activated_at
         ) VALUES (?, ?, ?, 'sandbox', 'kamino', 'vault_direct', ?, ?, ?, ?, 'Test Vault', sdp_iso_now())`
      )
      .bind(positionId, ORG, PROJECT, WALLET_ROW_ID, VAULT, SHARE_MINT, TOKEN_MINT),
  ]);
}

beforeEach(async () => {
  await seedTestDatabase(env);
  await seedPosition();
  vi.clearAllMocks();
  resolveVaultWithdrawClient.mockReturnValue({ buildVaultWithdrawal });
  buildVaultWithdrawal.mockResolvedValue(plan());
  // Matches the real resolver with the flag unset, the default everywhere here.
  resolveVaultSponsorship.mockResolvedValue({ kind: "wallet-pays" });
  simulateVaultPlan.mockResolvedValue({ ok: true });
  createOrgSignerForCustodyWallet.mockResolvedValue({ address: WALLET_ADDRESS });
  signVaultPlan.mockResolvedValue({
    bytes: new Uint8Array([1, 2, 3]),
    signature: SIGNATURE,
    lastValidBlockHeight: "12345",
  });
  broadcastVaultTransaction.mockResolvedValue(undefined);
});

describe("withdrawFromVault", () => {
  it("records one signed movement before broadcasting it", async () => {
    let recordedAtBroadcast: Record<string, unknown> | null = null;
    broadcastVaultTransaction.mockImplementation(async () => {
      recordedAtBroadcast = await getDb(env)
        .prepare("SELECT * FROM earn_movements WHERE direction = 'withdrawal'")
        .first<Record<string, unknown>>();
    });

    const result = await withdrawFromVault(env, input());

    expect(recordedAtBroadcast).toMatchObject({
      amount_requested: "10",
      denomination: SHARE_MINT,
      signature: SIGNATURE,
      source_address: VAULT,
      destination_address: WALLET_ADDRESS,
    });
    expect(result.movement).toMatchObject({ status: "submitted", signature: SIGNATURE });
    expect(broadcastVaultTransaction).toHaveBeenCalledOnce();
  });

  it("replays the original vault withdrawal for the same requestId and payload", async () => {
    const first = await withdrawFromVault(env, input());
    vi.clearAllMocks();

    const replay = await withdrawFromVault(env, input());

    expect(replay).toMatchObject({ replayed: true, movement: { id: first.movement.id } });
    expect(resolveVaultWithdrawClient).not.toHaveBeenCalled();
    expect(signVaultPlan).not.toHaveBeenCalled();
    expect(broadcastVaultTransaction).not.toHaveBeenCalled();
    // Exit safety: an exit replay must answer during a paymaster outage.
    expect(resolveVaultSponsorship).not.toHaveBeenCalled();
  });

  it("rejects the same requestId with a different payload", async () => {
    await withdrawFromVault(env, input());
    await expect(withdrawFromVault(env, input({ shares: "5" }))).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("leaves an ambiguous broadcast recorded for reconciliation", async () => {
    broadcastVaultTransaction.mockRejectedValue(new Error("timeout"));
    const result = await withdrawFromVault(env, input());
    expect(result.movement).toMatchObject({ status: "requested", signature: SIGNATURE });
  });

  it("validates asset identity and encoded shares before signing", async () => {
    buildVaultWithdrawal.mockResolvedValue(
      plan({ assetIdentity: { depositTokenMint: SHARE_MINT, shareMint: SHARE_MINT } })
    );
    await expect(withdrawFromVault(env, input())).rejects.toThrow(/does not match the position/);
    expect(signVaultPlan).not.toHaveBeenCalled();

    buildVaultWithdrawal.mockResolvedValue(plan({ accepted: { shares: "9" } }));
    await expect(withdrawFromVault(env, input())).rejects.toThrow(/shares do not match/);
  });

  it("stamps the idempotency memo onto the one transaction", async () => {
    signVaultPlan.mockImplementation(async (_env, execution) => {
      const memo = Buffer.from(execution.plan.instructions.at(-1)?.data ?? "", "base64").toString(
        "utf8"
      );
      expect(memo).toBe(`sdp:earn:vault-withdrawal:${input().requestId}`);
      return { bytes: new Uint8Array([1]), signature: SIGNATURE, lastValidBlockHeight: "12345" };
    });
    await withdrawFromVault(env, input());
    expect(signVaultPlan).toHaveBeenCalledOnce();
  });

  it("fails closed when the provider cannot build withdrawals", async () => {
    resolveVaultWithdrawClient.mockReturnValue(null);
    await expect(withdrawFromVault(env, input())).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
    });
  });

  /**
   * Refuses BEFORE the build, because the position is where the rent-refund
   * destination comes from. Falling back to the owner would hand the customer
   * lamports a sponsor put up.
   */
  it("refuses a position the organization does not hold", async () => {
    await expect(
      withdrawFromVault(env, input({ positionId: generateEarnPositionId() }))
    ).rejects.toThrow();
    expect(buildVaultWithdrawal).not.toHaveBeenCalled();
    expect(broadcastVaultTransaction).not.toHaveBeenCalled();
  });

  /**
   * Rent recovery. The share ATA's rent is refunded to whoever the DEPOSIT
   * recorded, not to whoever sponsors today: the fee mode can flip between
   * entering and exiting a position, and refunding a sponsor for rent the
   * customer paid would take the customer's lamports.
   */
  describe("share-ATA rent refund", () => {
    const SPONSOR = "4YhMUz8xDgHMPAevvfMpnJX9TJmw9DTNDA1sNWPRZG9q";

    it("refunds the funder recorded on the position", async () => {
      await getDb(env)
        .prepare("UPDATE earn_positions SET share_ata_rent_funder = ? WHERE id = ?")
        .bind(SPONSOR, positionId)
        .run();

      await withdrawFromVault(env, input());

      expect(buildVaultWithdrawal.mock.calls[0]?.[1]).toMatchObject({ rentRefundTo: SPONSOR });
    });

    it("names no refund destination when the wallet funded its own rent", async () => {
      await withdrawFromVault(env, input());

      expect(buildVaultWithdrawal.mock.calls[0]?.[1]).not.toHaveProperty("rentRefundTo");
    });
  });
});

describe("withdrawFromVault — the exit slippage floor", () => {
  it("cross-checks the encoded minAmountOut against the request in both directions", async () => {
    // Requested floor the builder silently dropped: fail closed, sign nothing.
    buildVaultWithdrawal.mockResolvedValue(plan());
    await expect(
      withdrawFromVault(env, input({ minAmountOut: "9.9", requestId: crypto.randomUUID() }))
    ).rejects.toThrow("omitted the canonical minAmountOut");

    // Floor the builder invented without a request: equally fail closed.
    buildVaultWithdrawal.mockResolvedValue(
      plan({ accepted: { shares: "10", minAmountOut: "9.9" } })
    );
    await expect(withdrawFromVault(env, input({ requestId: crypto.randomUUID() }))).rejects.toThrow(
      "does not match the policy-approved slippage floor"
    );

    // Matching floor signs and records it.
    const result = await withdrawFromVault(
      env,
      input({ minAmountOut: "9.9", requestId: crypto.randomUUID() })
    );
    expect(result.movement).toMatchObject({ status: "submitted" });
    expect(buildVaultWithdrawal.mock.calls.at(-1)?.[1]).toMatchObject({
      shares: "10",
      minAmountOut: "9.9",
    });
    expect(broadcastVaultTransaction).toHaveBeenCalledTimes(1);
  });

  it("maps a provider exit refusal into the caller's 400, in the provider's words", async () => {
    const { SdpVedaError } = await import("@sdp/veda");
    buildVaultWithdrawal.mockRejectedValue(
      new SdpVedaError("WITHDRAW_REFUSED", "Shares are locked until the unlock timestamp")
    );

    await expect(withdrawFromVault(env, input({ minAmountOut: "9.9" }))).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("Shares are locked"),
    });
    expect(signVaultPlan).not.toHaveBeenCalled();
  });
});
