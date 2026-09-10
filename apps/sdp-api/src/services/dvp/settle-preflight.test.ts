import type { SolanaRpc } from "@sdp/rpc/solana";
import { address, createSolanaRpc, lamports } from "@solana/kit";
import { extension, getTokenSize, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchEncodedAccounts = vi.hoisted(() => vi.fn());
const getMinimumBalanceForRentExemption = vi.hoisted(() => vi.fn());

vi.mock("@solana/kit", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchEncodedAccounts,
}));
vi.mock("@sdp/rpc/solana", () => ({ getMinimumBalanceForRentExemption }));
vi.mock("@solana-program/token-2022", async (importOriginal) => ({
  ...(await importOriginal()),
  getTokenDecoder: () => ({
    decode: (data: Uint8Array) => {
      if (data.length === 0) {
        throw new Error("invalid token bytes");
      }
      return { owner: data[0] === 1 ? USER_A : OTHER };
    },
  }),
  getMintDecoder: () => ({
    decode: (data: Uint8Array) => ({
      extensions:
        data[0] === 1
          ? { __option: "Some", value: [{ __kind: "TransferHook" }] }
          : { __option: "None" },
    }),
  }),
}));

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

describe("settle preflight", () => {
  beforeEach(() => vi.clearAllMocks());

  it("treats a dusted system-owned ATA address as missing", async () => {
    fetchEncodedAccounts.mockResolvedValue([
      { exists: true, address: ATA_A, programAddress: OTHER, data: new Uint8Array() },
    ]);

    await expect(findMissingSettleAtas(RPC, atas, parties, ["userAAtaA"])).resolves.toEqual(
      new Set(["userAAtaA"])
    );
  });

  it("rejects a reassigned ATA and names the account", async () => {
    fetchEncodedAccounts.mockResolvedValue([
      {
        exists: true,
        address: ATA_A,
        programAddress: TOKEN_2022_PROGRAM_ADDRESS,
        data: new Uint8Array([2]),
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
        data: new Uint8Array([2]),
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
        data: new Uint8Array([1]),
      },
      {
        exists: true,
        address: MINT_B,
        programAddress: TOKEN_2022_PROGRAM_ADDRESS,
        data: new Uint8Array([0]),
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
    expect(result.required).toBe(50_345n);
  });
});
