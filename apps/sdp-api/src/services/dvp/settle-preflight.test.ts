import type { SolanaRpc } from "@sdp/rpc/solana";
import { address, createSolanaRpc, lamports, none, some } from "@solana/kit";
import {
  AccountState,
  type ExtensionArgs,
  extension,
  getMintEncoder,
  getTokenEncoder,
  getTokenSize,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchEncodedAccounts = vi.hoisted(() => vi.fn());
const getMinimumBalanceForRentExemption = vi.hoisted(() => vi.fn());

vi.mock("@solana/kit", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchEncodedAccounts,
}));
vi.mock("@sdp/rpc/solana", () => ({ getMinimumBalanceForRentExemption }));
const { findMissingSettleAtas, findSettlementFundingShortfall } = await import(
  "./settle-preflight"
);

const USER_A = address("5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn");
const USER_B = address("7WLcnnT1nnPuHiWaVnAY3Uz8Y2SgFy2VMg2t7GAoxnpg");
const OTHER = address("11111111111111111111111111111111");
const MINT_A = address("ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1");
const MINT_B = address("AqTgvZaiZ18ykVvzaQhfB2KQ4SGDw4i1o5rQqBAMsZiE");
const ATA_A = address("FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU");
const ATA_B = address("6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y");
const RPC = createSolanaRpc("http://localhost");
const parties = {
  userA: USER_A,
  userB: USER_B,
  userASettlementDestination: USER_A,
  userBSettlementDestination: USER_B,
  mintA: MINT_A,
  mintB: MINT_B,
  tokenProgramA: TOKEN_2022_PROGRAM_ADDRESS,
  tokenProgramB: TOKEN_2022_PROGRAM_ADDRESS,
};
const atas = {
  userADestinationAtaB: ATA_A,
  userBDestinationAtaA: ATA_B,
  userAAtaA: ATA_A,
  userBAtaB: ATA_B,
};

function token(owner: ReturnType<typeof address> = USER_A): Uint8Array {
  return new Uint8Array(
    getTokenEncoder().encode({
      mint: MINT_A,
      owner,
      amount: 0n,
      delegate: null,
      state: AccountState.Initialized,
      isNative: null,
      delegatedAmount: 0n,
      closeAuthority: null,
      extensions: null,
    })
  );
}

function mint(extensions: ExtensionArgs[]): Uint8Array {
  return new Uint8Array(
    getMintEncoder().encode({
      mintAuthority: some(USER_A),
      supply: 0n,
      decimals: 6,
      isInitialized: true,
      freezeAuthority: none(),
      extensions: extensions.length === 0 ? none() : some(extensions),
    })
  );
}

describe("settle preflight", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects an ATA address owned by the wrong program", async () => {
    fetchEncodedAccounts.mockResolvedValue([
      { exists: true, address: ATA_A, programAddress: OTHER, data: new Uint8Array() },
    ]);

    await expect(findMissingSettleAtas(RPC, atas, parties, ["userAAtaA"])).rejects.toThrow(
      new RegExp(`${ATA_A}.*owned by ${OTHER}.*${TOKEN_2022_PROGRAM_ADDRESS}`)
    );
  });

  it("rejects a reassigned ATA and names the account", async () => {
    fetchEncodedAccounts.mockResolvedValue([
      {
        exists: true,
        address: ATA_A,
        programAddress: TOKEN_2022_PROGRAM_ADDRESS,
        data: token(OTHER),
      },
    ]);

    await expect(findMissingSettleAtas(RPC, atas, parties, ["userAAtaA"])).rejects.toThrow(
      new RegExp(`${ATA_A}.*reassigned`)
    );
  });

  it("rejects a reassigned cancel refund ATA and names the account", async () => {
    fetchEncodedAccounts.mockResolvedValue([
      {
        exists: true,
        address: ATA_B,
        programAddress: TOKEN_2022_PROGRAM_ADDRESS,
        data: token(OTHER),
      },
    ]);

    await expect(findMissingSettleAtas(RPC, atas, parties, ["userBAtaB"])).rejects.toThrow(
      new RegExp(`${ATA_B}.*reassigned`)
    );
  });

  it("rejects an undecodable token account with a named bad request", async () => {
    fetchEncodedAccounts.mockResolvedValue([
      {
        exists: true,
        address: ATA_A,
        programAddress: TOKEN_2022_PROGRAM_ADDRESS,
        data: new Uint8Array(),
      },
    ]);

    await expect(findMissingSettleAtas(RPC, atas, parties, ["userAAtaA"])).rejects.toThrow(
      new RegExp(`${ATA_A}.*cannot be decoded`)
    );
  });

  it("uses Token-2022 mint extensions and ImmutableOwner to size rent", async () => {
    fetchEncodedAccounts.mockResolvedValue([
      {
        exists: true,
        address: MINT_A,
        programAddress: TOKEN_2022_PROGRAM_ADDRESS,
        data: mint([
          extension("TransferHook", { authority: USER_A, programId: OTHER }),
          extension("PausableConfig", { authority: some(USER_A), paused: false }),
        ]),
      },
      {
        exists: true,
        address: MINT_B,
        programAddress: TOKEN_2022_PROGRAM_ADDRESS,
        data: mint([]),
      },
    ]);
    getMinimumBalanceForRentExemption.mockImplementation(async (_rpc: unknown, size: number) =>
      BigInt(size)
    );
    const rpcWithBalance = {
      getBalance: () => ({
        send: async () => ({ context: { slot: 1n }, value: lamports(1_000_000n) }),
      }),
    } as unknown as SolanaRpc;

    const result = await findSettlementFundingShortfall(
      rpcWithBalance,
      USER_A,
      parties,
      new Set(["userAAtaA", "userBAtaB"])
    );

    expect(getTokenSize([extension("ImmutableOwner", {})])).toBe(170);
    expect(result.required).toBeGreaterThan(50_345n);
    expect(getMinimumBalanceForRentExemption).toHaveBeenCalledTimes(2);
  });

  // Mirrors `ExtensionType::required_init_account_extensions` in Token-2022's
  // interface crate: ConfidentialTransferMint forces no account extension (the
  // account side is opt-in), TransferFeeConfig forces TransferFeeAmount.
  it("sizes rent by the account extensions the program forces, and only those", async () => {
    fetchEncodedAccounts.mockResolvedValue([
      {
        exists: true,
        address: MINT_A,
        programAddress: TOKEN_2022_PROGRAM_ADDRESS,
        data: mint([
          extension("ConfidentialTransferMint", {
            authority: some(USER_A),
            autoApproveNewAccounts: true,
            auditorElgamalPubkey: none(),
          }),
        ]),
      },
      {
        exists: true,
        address: MINT_B,
        programAddress: TOKEN_2022_PROGRAM_ADDRESS,
        data: mint([
          extension("TransferFeeConfig", {
            transferFeeConfigAuthority: USER_A,
            withdrawWithheldAuthority: USER_A,
            withheldAmount: 0n,
            olderTransferFee: { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: 0 },
            newerTransferFee: { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: 0 },
          }),
        ]),
      },
    ]);
    const sizes: number[] = [];
    getMinimumBalanceForRentExemption.mockImplementation(async (_rpc: unknown, size: number) => {
      sizes.push(size);
      return BigInt(size);
    });
    const rpcWithBalance = {
      getBalance: () => ({
        send: async () => ({ context: { slot: 1n }, value: lamports(1_000_000n) }),
      }),
    } as unknown as SolanaRpc;

    await findSettlementFundingShortfall(
      rpcWithBalance,
      USER_A,
      parties,
      new Set(["userAAtaA", "userBAtaB"])
    );

    expect(sizes.sort()).toEqual(
      [
        getTokenSize([extension("ImmutableOwner", {})]),
        getTokenSize([
          extension("ImmutableOwner", {}),
          extension("TransferFeeAmount", { withheldAmount: 0n }),
        ]),
      ].sort()
    );
  });

  it("uses only the fee balance when no accounts need creation", async () => {
    const rpcWithBalance = {
      getBalance: () => ({ send: async () => ({ value: lamports(100_000n) }) }),
    } as unknown as SolanaRpc;
    await expect(
      findSettlementFundingShortfall(rpcWithBalance, USER_A, parties, new Set())
    ).resolves.toEqual({ balance: 100_000n, required: 50_000n, shortfall: 0n });
    expect(fetchEncodedAccounts).not.toHaveBeenCalled();
    expect(getMinimumBalanceForRentExemption).not.toHaveBeenCalled();
  });

  it("deduplicates rent lookups for accounts with the same size", async () => {
    fetchEncodedAccounts.mockResolvedValue([
      { exists: true, address: MINT_A, programAddress: TOKEN_2022_PROGRAM_ADDRESS, data: mint([]) },
    ]);
    getMinimumBalanceForRentExemption.mockResolvedValue(1n);
    const rpcWithBalance = {
      getBalance: () => ({ send: async () => ({ value: lamports(100_000n) }) }),
    } as unknown as SolanaRpc;
    await findSettlementFundingShortfall(
      rpcWithBalance,
      USER_A,
      parties,
      new Set(["userBDestinationAtaA", "userAAtaA"])
    );
    expect(getMinimumBalanceForRentExemption).toHaveBeenCalledTimes(1);
  });
});
