import { address, createSolanaRpc } from "@solana/kit";
import {
  AccountState,
  getTokenEncoder,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchEncodedAccounts = vi.hoisted(() => vi.fn());

vi.mock("@solana/kit", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchEncodedAccounts,
}));
const { findMissingSettleAtas } = await import("./settle-preflight");

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
});
