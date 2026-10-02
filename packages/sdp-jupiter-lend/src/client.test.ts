import { readStamp, withReadFloor } from "@sdp/rpc/read-context";
import { JUPITER_LEND_EARN_PROGRAM_IDS, JUPITER_LEND_USDT } from "@sdp/types/jupiter-lend-programs";
import {
  type AccountInfo,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  getDepositContext: vi.fn(),
  getWithdrawContext: vi.fn(),
  getLendingTokenDetails: vi.fn(),
  getOrCreateATAInstruction: vi.fn(),
  getLendingProgram: vi.fn(),
  depositWithMinAmountOut: vi.fn(),
  redeemWithMinAmountOut: vi.fn(),
}));

vi.mock("@jup-ag/lend/earn", () => sdk);

const { JupiterLendVaultDirectClient } = await import("./client");

const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const owner = new PublicKey("11111111111111111111111111111112");
const rentPayer = new PublicKey("11111111111111111111111111111113");
const shareMint = new PublicKey(JUPITER_LEND_USDT.shareMint);
const assetMint = new PublicKey(JUPITER_LEND_USDT.assetMint);
const shareAta = new PublicKey("11111111111111111111111111111114");
const runtime = { environment: "production" as const, env: {} };
const ownerShareAta = PublicKey.findProgramAddressSync(
  [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), shareMint.toBuffer()],
  ATA_PROGRAM
)[0];

function shareAccount(
  amount: bigint,
  layout: {
    program?: PublicKey;
    size?: number;
    mint?: PublicKey;
    holder?: PublicKey;
    state?: number;
  } = {}
): AccountInfo<Buffer> {
  const data = Buffer.alloc(layout.size ?? 165);
  (layout.mint ?? shareMint).toBuffer().copy(data, 0);
  (layout.holder ?? owner).toBuffer().copy(data, 32);
  if (data.length >= 72) data.writeBigUInt64LE(amount, 64);
  if (data.length > 108) data.writeUInt8(layout.state ?? 1, 108);
  return { executable: false, owner: layout.program ?? TOKEN_PROGRAM, lamports: 2_039_280, data };
}

function liquidityResponse(withdrawable: string) {
  return new Response(
    JSON.stringify([
      {
        address: JUPITER_LEND_USDT.shareMint,
        assetAddress: JUPITER_LEND_USDT.assetMint,
        decimals: JUPITER_LEND_USDT.decimals,
        liquiditySupplyData: { withdrawable },
      },
    ]),
    { status: 200 }
  );
}

function mockJupiterLiquidity(withdrawable = "100000000") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => liquidityResponse(withdrawable))
  );
}

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
  mockJupiterLiquidity();
  vi.spyOn(Connection.prototype, "getAccountInfo").mockResolvedValue(shareAccount(4_500_000n));
  vi.spyOn(Connection.prototype, "getTokenAccountBalance");
  const depositContext = {
    fTokenMint: shareMint,
    recipientTokenAccount: shareAta,
  };
  const withdrawContext = {
    fTokenMint: shareMint,
    recipientTokenAccount: shareAta,
  };
  sdk.getDepositContext.mockResolvedValue(depositContext);
  sdk.getWithdrawContext.mockResolvedValue(withdrawContext);
  sdk.getLendingTokenDetails.mockResolvedValue({
    address: shareMint,
    asset: new PublicKey(JUPITER_LEND_USDT.assetMint),
    decimals: JUPITER_LEND_USDT.decimals,
    convertToShares: new BN(950_000),
    convertToAssets: new BN(1_052_631),
  });
  sdk.getOrCreateATAInstruction.mockResolvedValue([instruction(ATA_PROGRAM)]);
  sdk.depositWithMinAmountOut.mockImplementation(() => ({
    accounts: vi.fn(() => ({
      instruction: vi
        .fn()
        .mockResolvedValue(
          instruction(new PublicKey(JUPITER_LEND_EARN_PROGRAM_IDS["mainnet-beta"] as string))
        ),
    })),
  }));
  sdk.redeemWithMinAmountOut.mockImplementation(() => ({
    accounts: vi.fn(() => ({
      instruction: vi
        .fn()
        .mockResolvedValue(
          instruction(new PublicKey(JUPITER_LEND_EARN_PROGRAM_IDS["mainnet-beta"] as string))
        ),
    })),
  }));
  sdk.getLendingProgram.mockReturnValue({
    methods: {
      depositWithMinAmountOut: sdk.depositWithMinAmountOut,
      redeemWithMinAmountOut: sdk.redeemWithMinAmountOut,
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("JupiterLendVaultDirectClient", () => {
  it("builds a canonical deposit plan and rewrites ATA rent to the supplied payer", async () => {
    const plan = await client().buildVaultDeposit(runtime, {
      providerReference: JUPITER_LEND_USDT.assetMint,
      owner: owner.toBase58(),
      rentPayer: rentPayer.toBase58(),
      amount: "5.250000",
      minSharesOut: "4.98",
    });

    expect(plan.assetIdentity).toEqual({
      depositTokenMint: JUPITER_LEND_USDT.assetMint,
      shareMint: JUPITER_LEND_USDT.shareMint,
    });
    expect(plan.accepted).toEqual({ amount: "5.25", minSharesOut: "4.98" });
    expect(plan.createsShareAccount).toBe(true);
    expect(plan.instructions[0]?.accounts[0]).toEqual({ address: rentPayer.toBase58(), role: 3 });
    expect(sdk.depositWithMinAmountOut).toHaveBeenCalledWith(new BN(5_250_000), new BN(4_980_000));
  });

  it("builds redeem-by-shares and reports the exact accepted quantity", async () => {
    const plan = await client().buildVaultWithdrawal(runtime, {
      providerReference: JUPITER_LEND_USDT.assetMint,
      owner: owner.toBase58(),
      shares: "4.5",
      minAmountOut: "4.7",
    });
    expect(plan.accepted).toEqual({ shares: "4.5", minAmountOut: "4.7" });
    expect(sdk.redeemWithMinAmountOut).toHaveBeenCalledWith(new BN(4_500_000), new BN(4_700_000));
  });

  it("quotes live deposit and withdrawal rates in token units", async () => {
    await expect(
      client().quoteVaultDeposit(runtime, {
        providerReference: JUPITER_LEND_USDT.assetMint,
        amount: "5",
      })
    ).resolves.toEqual({ sharesOut: "4.75", shareDecimals: 6, blockingIssues: [] });
    await expect(
      client().quoteVaultWithdrawal(runtime, {
        providerReference: JUPITER_LEND_USDT.assetMint,
        shares: "4.5",
      })
    ).resolves.toEqual({ assetsOut: "4.736839", assetDecimals: 6, blockingIssues: [] });
  });

  it("reads jlUSDT shares and their current USDT value", async () => {
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
        tokenValue: "4.736839",
        tokenMint: JUPITER_LEND_USDT.assetMint,
        shareMint: JUPITER_LEND_USDT.shareMint,
      },
    ]);
  });

  it("caps immediately withdrawable shares by Jupiter's current USDT liquidity", async () => {
    // 2.105262 USDT / 1.052631 USDT per share = 2 shares, rounded down.
    mockJupiterLiquidity("2105262");
    await expect(
      client().readVaultPositions(runtime, {
        owner: owner.toBase58(),
        providerReferences: [JUPITER_LEND_USDT.assetMint],
      })
    ).resolves.toEqual([expect.objectContaining({ shares: "4.5", withdrawableShares: "2" })]);
  });

  it("reads the share balance from the account's own bytes in one RPC call", async () => {
    await client().readVaultPositions(runtime, {
      owner: owner.toBase58(),
      providerReferences: [JUPITER_LEND_USDT.assetMint],
    });
    expect(Connection.prototype.getAccountInfo).toHaveBeenCalledTimes(1);
    expect(Connection.prototype.getAccountInfo).toHaveBeenCalledWith(ownerShareAta);
    expect(Connection.prototype.getTokenAccountBalance).not.toHaveBeenCalled();
    expect(sdk.getWithdrawContext).not.toHaveBeenCalled();
  });

  it("returns zero only when the jlUSDT account is confirmed missing", async () => {
    vi.mocked(Connection.prototype.getAccountInfo).mockResolvedValueOnce(null);
    await expect(
      client().readVaultPositions(runtime, {
        owner: owner.toBase58(),
        providerReferences: [JUPITER_LEND_USDT.assetMint],
      })
    ).resolves.toEqual([
      expect.objectContaining({ shares: "0", withdrawableShares: "0", tokenValue: "0" }),
    ]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("reads a frozen jlUSDT account's balance", async () => {
    vi.mocked(Connection.prototype.getAccountInfo).mockResolvedValueOnce(
      shareAccount(18_446_744_073_709_551_615n, { state: 2 })
    );
    await expect(
      client().readVaultPositions(runtime, {
        owner: owner.toBase58(),
        providerReferences: [JUPITER_LEND_USDT.assetMint],
      })
    ).resolves.toEqual([expect.objectContaining({ shares: "18446744073709.551615" })]);
  });

  it("reads an ATA whose token owner was reassigned, as getTokenAccountBalance does", async () => {
    vi.mocked(Connection.prototype.getAccountInfo).mockResolvedValueOnce(
      shareAccount(2_000_000_000n, { holder: rentPayer })
    );
    await expect(
      client().readVaultPositions(runtime, {
        owner: owner.toBase58(),
        providerReferences: [JUPITER_LEND_USDT.assetMint],
      })
    ).resolves.toEqual([
      expect.objectContaining({
        owner: owner.toBase58(),
        shares: "2000",
        withdrawableShares: "95.000052",
        tokenValue: "2105.262",
      }),
    ]);
  });

  it("preserves an existing jlUSDT account's RPC read failure as unavailable", async () => {
    vi.mocked(Connection.prototype.getAccountInfo).mockRejectedValueOnce(
      new Error("RPC unavailable")
    );
    await expect(
      client().readVaultPositions(runtime, {
        owner: owner.toBase58(),
        providerReferences: [JUPITER_LEND_USDT.assetMint],
      })
    ).rejects.toMatchObject({ code: "VAULT_UNREADABLE" });
  });

  it.each([
    ["program", { program: assetMint }],
    ["program (lamports sent to the address)", { program: SystemProgram.programId, size: 0 }],
    ["size", { size: 82 }],
    ["mint", { mint: assetMint }],
    ["uninitialized state", { state: 0 }],
    ["unknown state", { state: 3 }],
  ])(
    "refuses a share account with the wrong %s instead of reading zero",
    async (_field, layout) => {
      vi.mocked(Connection.prototype.getAccountInfo).mockResolvedValueOnce(
        shareAccount(4_500_000n, layout)
      );
      await expect(
        client().readVaultPositions(runtime, {
          owner: owner.toBase58(),
          providerReferences: [JUPITER_LEND_USDT.assetMint],
        })
      ).rejects.toMatchObject({
        code: "VAULT_UNREADABLE",
        message: "Could not read the Jupiter Lend USDT position",
      });
    }
  );

  it("answers the SDK's pinned-mint reads locally and leaves the share-account read live", async () => {
    await client().buildVaultDeposit(runtime, {
      providerReference: JUPITER_LEND_USDT.assetMint,
      owner: owner.toBase58(),
      amount: "1",
      minSharesOut: "0.9",
    });
    expect(Connection.prototype.getAccountInfo).not.toHaveBeenCalled();

    const [{ connection: contextConnection }] = sdk.getDepositContext.mock.calls[0] as [
      { connection: Connection },
    ];
    const [, , ataConnection] = sdk.getOrCreateATAInstruction.mock.calls[0] as [
      PublicKey,
      PublicKey,
      Connection,
    ];
    expect(ataConnection).toBe(contextConnection);
    await expect(ataConnection.getAccountInfo(assetMint)).resolves.toMatchObject({
      owner: TOKEN_PROGRAM,
    });
    await expect(ataConnection.getAccountInfo(shareMint)).resolves.toMatchObject({
      owner: TOKEN_PROGRAM,
    });
    expect(Connection.prototype.getAccountInfo).not.toHaveBeenCalled();
    await expect(ataConnection.getAccountInfo(ownerShareAta, "confirmed")).resolves.toEqual(
      shareAccount(4_500_000n)
    );
    expect(Connection.prototype.getAccountInfo).toHaveBeenCalledTimes(1);
    expect(Connection.prototype.getAccountInfo).toHaveBeenCalledWith(ownerShareAta, "confirmed");
  });

  it("shares one in-flight liquidity read between concurrent quotes, never a settled one", async () => {
    const quote = () =>
      client().quoteVaultWithdrawal(runtime, {
        providerReference: JUPITER_LEND_USDT.assetMint,
        shares: "1",
      });
    await Promise.all([quote(), quote()]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    await quote();
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("never lets a floored quote join a liquidity read sent before its floor", async () => {
    let releaseStale: (response: Response) => void = () => undefined;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              releaseStale = resolve;
            })
        )
        .mockImplementation(async () => liquidityResponse("100000000"))
    );
    const quote = () =>
      client().quoteVaultWithdrawal(runtime, {
        providerReference: JUPITER_LEND_USDT.assetMint,
        shares: "4.5",
      });
    const stale = quote();
    onTestFinished(() => releaseStale(liquidityResponse("1000000")));
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));

    await expect(withReadFloor(readStamp(), quote)).resolves.toMatchObject({
      blockingIssues: [],
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);

    releaseStale(liquidityResponse("1000000"));
    await expect(stale).resolves.toMatchObject({
      blockingIssues: [expect.objectContaining({ code: "INSUFFICIENT_WITHDRAWAL_LIQUIDITY" })],
    });
  });

  it("reports a withdrawal quote blocked by current protocol liquidity", async () => {
    mockJupiterLiquidity("1000000");
    await expect(
      client().quoteVaultWithdrawal(runtime, {
        providerReference: JUPITER_LEND_USDT.assetMint,
        shares: "4.5",
      })
    ).resolves.toEqual({
      assetsOut: "4.736839",
      assetDecimals: 6,
      blockingIssues: [
        {
          code: "INSUFFICIENT_WITHDRAWAL_LIQUIDITY",
          message:
            "The requested shares exceed Jupiter Lend's current immediately withdrawable USDT liquidity.",
        },
      ],
    });
  });

  it("uses the shared unreadable-vault code when live withdrawal liquidity cannot be read", async () => {
    mockJupiterLiquidity("not-an-amount");
    await expect(
      client().quoteVaultWithdrawal(runtime, {
        providerReference: JUPITER_LEND_USDT.assetMint,
        shares: "1",
      })
    ).rejects.toMatchObject({ code: "VAULT_UNREADABLE" });
  });

  it("refuses devnet and missing slippage floors", async () => {
    const integration = client();
    await expect(
      integration.buildVaultDeposit(
        { environment: "sandbox", env: {} },
        {
          providerReference: JUPITER_LEND_USDT.assetMint,
          owner: owner.toBase58(),
          amount: "1",
          minSharesOut: "0.99",
        }
      )
    ).rejects.toMatchObject({ code: "CLUSTER_UNSUPPORTED" });
    await expect(
      integration.buildVaultDeposit(runtime, {
        providerReference: JUPITER_LEND_USDT.assetMint,
        owner: owner.toBase58(),
        amount: "1",
      })
    ).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    await expect(
      integration.buildVaultWithdrawal(runtime, {
        providerReference: JUPITER_LEND_USDT.assetMint,
        owner: owner.toBase58(),
        shares: "1",
      })
    ).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
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
        minSharesOut: "0.99",
      })
    ).rejects.toMatchObject({ code: "PROGRAM_MISMATCH" });
    expect(sdk.depositWithMinAmountOut).not.toHaveBeenCalled();
  });

  it("fails closed when the live quote resolves to another market", async () => {
    sdk.getLendingTokenDetails.mockResolvedValue({
      address: shareMint,
      asset: owner,
      decimals: 6,
      convertToShares: new BN(1_000_000),
      convertToAssets: new BN(1_000_000),
    });
    await expect(
      client().quoteVaultDeposit(runtime, {
        providerReference: JUPITER_LEND_USDT.assetMint,
        amount: "1",
      })
    ).rejects.toMatchObject({ code: "PROGRAM_MISMATCH" });
  });

  it("refuses a mixed position-reference request instead of returning a partial page", async () => {
    await expect(
      client().readVaultPositions(runtime, {
        owner: owner.toBase58(),
        providerReferences: [JUPITER_LEND_USDT.assetMint, owner.toBase58()],
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(sdk.getWithdrawContext).not.toHaveBeenCalled();
  });
});
