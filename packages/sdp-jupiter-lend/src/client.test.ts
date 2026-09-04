import { JUPITER_LEND_EARN_PROGRAM_IDS, JUPITER_LEND_USDT } from "@sdp/types/jupiter-lend-programs";
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  getDepositContext: vi.fn(),
  getDepositIxs: vi.fn(),
  getRedeemIxs: vi.fn(),
  getUserLendingPositionByAsset: vi.fn(),
}));

vi.mock("@jup-ag/lend/earn", () => sdk);

const { JupiterLendVaultDirectClient } = await import("./client");

const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const owner = new PublicKey("11111111111111111111111111111112");
const rentPayer = new PublicKey("11111111111111111111111111111113");
const shareMint = new PublicKey(JUPITER_LEND_USDT.shareMint);
const shareAta = new PublicKey("11111111111111111111111111111114");
const runtime = { environment: "production" as const, env: {} };

function instruction(programId: PublicKey, payer = owner) {
  return new TransactionInstruction({
    programId,
    keys: [{ pubkey: payer, isSigner: true, isWritable: true }],
    data: Buffer.from([1, 2, 3]),
  });
}

function client() {
  return new JupiterLendVaultDirectClient(
    vi.fn().mockResolvedValue("http://rpc.example.invalid"),
    async (_label, operation) => operation(() => undefined)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sdk.getDepositContext.mockResolvedValue({
    fTokenMint: shareMint,
    recipientTokenAccount: shareAta,
  });
  // The client constructs the connection internally; the SDK functions stay mocked.
  vi.spyOn(Connection.prototype, "getAccountInfo").mockResolvedValue(null);
});

afterEach(() => vi.restoreAllMocks());

describe("JupiterLendVaultDirectClient", () => {
  it("builds a canonical deposit plan and rewrites ATA rent to the supplied payer", async () => {
    sdk.getDepositIxs.mockResolvedValue({
      ixs: [
        instruction(ATA_PROGRAM),
        instruction(new PublicKey(JUPITER_LEND_EARN_PROGRAM_IDS["mainnet-beta"] as string)),
      ],
    });

    const plan = await client().buildVaultDeposit(runtime, {
      providerReference: JUPITER_LEND_USDT.assetMint,
      owner: owner.toBase58(),
      rentPayer: rentPayer.toBase58(),
      amount: "5.250000",
    });

    expect(plan.assetIdentity).toEqual({
      depositTokenMint: JUPITER_LEND_USDT.assetMint,
      shareMint: JUPITER_LEND_USDT.shareMint,
    });
    expect(plan.accepted).toEqual({ amount: "5.25" });
    expect(plan.createsShareAccount).toBe(true);
    expect(plan.instructions[0]?.accounts[0]).toEqual({ address: rentPayer.toBase58(), role: 3 });
    expect(sdk.getDepositIxs).toHaveBeenCalledWith(
      expect.objectContaining({ amount: new BN(5_250_000), market: "main", includeWrapSol: false })
    );
  });

  it("builds redeem-by-shares and reports the exact accepted quantity", async () => {
    sdk.getRedeemIxs.mockResolvedValue({
      ixs: [instruction(new PublicKey(JUPITER_LEND_EARN_PROGRAM_IDS["mainnet-beta"] as string))],
    });
    const plan = await client().buildVaultWithdrawal(runtime, {
      providerReference: JUPITER_LEND_USDT.assetMint,
      owner: owner.toBase58(),
      shares: "4.5",
    });
    expect(plan.accepted).toEqual({ shares: "4.5" });
    expect(sdk.getRedeemIxs).toHaveBeenCalledWith(
      expect.objectContaining({ shares: new BN(4_500_000), market: "main" })
    );
  });

  it("reads jlUSDT shares and their current USDT value", async () => {
    sdk.getUserLendingPositionByAsset.mockResolvedValue({
      lendingTokenShares: new BN(4_500_000),
      underlyingAssets: new BN(4_750_000),
      underlyingBalance: new BN(100),
    });
    await expect(
      client().readVaultPositions(runtime, {
        owner: owner.toBase58(),
        providerReferences: [JUPITER_LEND_USDT.assetMint],
      })
    ).resolves.toEqual([
      {
        providerReference: JUPITER_LEND_USDT.assetMint,
        owner: owner.toBase58(),
        cluster: "mainnet-beta",
        shares: "4.5",
        withdrawableShares: "4.5",
        tokenValue: "4.75",
        tokenMint: JUPITER_LEND_USDT.assetMint,
        shareMint: JUPITER_LEND_USDT.shareMint,
      },
    ]);
  });

  it("refuses devnet and unenforceable slippage floors", async () => {
    const integration = client();
    await expect(
      integration.buildVaultDeposit(
        { environment: "sandbox", env: {} },
        { providerReference: JUPITER_LEND_USDT.assetMint, owner: owner.toBase58(), amount: "1" }
      )
    ).rejects.toMatchObject({ code: "CLUSTER_UNSUPPORTED" });
    await expect(
      integration.buildVaultDeposit(runtime, {
        providerReference: JUPITER_LEND_USDT.assetMint,
        owner: owner.toBase58(),
        amount: "1",
        minSharesOut: "1",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      integration.buildVaultWithdrawal(runtime, {
        providerReference: JUPITER_LEND_USDT.assetMint,
        owner: owner.toBase58(),
        shares: "1",
        minAmountOut: "1",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("fails closed when the SDK derives a different receipt mint", async () => {
    sdk.getDepositContext.mockResolvedValue({
      fTokenMint: new PublicKey("11111111111111111111111111111115"),
      recipientTokenAccount: shareAta,
    });
    await expect(
      client().buildVaultDeposit(runtime, {
        providerReference: JUPITER_LEND_USDT.assetMint,
        owner: owner.toBase58(),
        amount: "1",
      })
    ).rejects.toMatchObject({ code: "PROGRAM_MISMATCH" });
    expect(sdk.getDepositIxs).not.toHaveBeenCalled();
  });

  it("refuses a mixed position-reference request instead of returning a partial page", async () => {
    await expect(
      client().readVaultPositions(runtime, {
        owner: owner.toBase58(),
        providerReferences: [JUPITER_LEND_USDT.assetMint, owner.toBase58()],
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(sdk.getUserLendingPositionByAsset).not.toHaveBeenCalled();
  });
});
