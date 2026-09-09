/**
 * Reading a trade's on-chain state.
 *
 * The load-bearing question here is not "what is the balance" but "is absence
 * being told apart from failure". The reconciler turns absence into a TERMINAL
 * status, so reporting absence for a timed-out RPC permanently kills a live
 * trade, and reporting failure for a genuinely missing account leaves a dead
 * row sweeping forever. Both directions are tested.
 */

import { SwapDvpVerificationError } from "@sdp/dvp";
import type { SolanaRpc } from "@sdp/rpc/solana";
import type { Address } from "@solana/kit";
import { AccountState, getTokenEncoder } from "@solana-program/token-2022";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchEncodedAccounts = vi.hoisted(() => vi.fn());
const verifySwapDvpAccount = vi.hoisted(() => vi.fn());

vi.mock("@solana/kit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@solana/kit")>()),
  fetchEncodedAccounts,
}));
vi.mock("@sdp/dvp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sdp/dvp")>()),
  verifySwapDvpAccount,
}));

const { readDvpTradeObservation, readEscrowState } = await import("./read-chain");

const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
const SWAP = "BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po" as Address;
const ESCROW_A = "FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU" as Address;
const ESCROW_B = "6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y" as Address;
const MINT = "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1" as Address;
const OWNER = "5vJRzKtcp4b3Ptw9c8s3s2LrCC1cvJUY4Y3xvJXfj3Zn" as Address;

const rpc = {} as SolanaRpc;
const legs = {
  a: { escrow: ESCROW_A, tokenProgram: T22 },
  b: { escrow: ESCROW_B, tokenProgram: T22 },
};

/** A real encoded token account, so the decoder is exercised rather than faked. */
function tokenAccount(
  address: Address,
  { amount, frozen = false }: { amount: bigint; frozen?: boolean },
  programAddress: Address = T22
) {
  const data = getTokenEncoder().encode({
    mint: MINT,
    owner: OWNER,
    amount,
    delegate: null,
    state: frozen ? AccountState.Frozen : AccountState.Initialized,
    isNative: null,
    delegatedAmount: 0n,
    closeAuthority: null,
    extensions: null,
  });
  return { address, exists: true as const, data, programAddress, executable: false, lamports: 1n };
}

function missing(address: Address) {
  return { address, exists: false as const };
}

function tradeAccount(address: Address = SWAP) {
  return {
    address,
    exists: true as const,
    data: new Uint8Array(458),
    programAddress: "dvp34bdbcEm4f4FCUjGV4mDAkDshaQR4LkK8fdcsyZq" as Address,
    executable: false,
    lamports: 1n,
  };
}

describe("readDvpTradeObservation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    verifySwapDvpAccount.mockResolvedValue({ address: SWAP });
  });

  it("reports a live trade and both funded escrows", async () => {
    fetchEncodedAccounts.mockResolvedValue([
      tradeAccount(),
      tokenAccount(ESCROW_A, { amount: 1000n }),
      tokenAccount(ESCROW_B, { amount: 2000n }),
    ]);

    const observation = await readDvpTradeObservation(rpc, SWAP, legs, 500n);

    expect(observation.tradeAccountExists).toBe(true);
    expect(observation.legA).toEqual({ exists: true, amount: 1000n, frozen: false });
    expect(observation.legB).toEqual({ exists: true, amount: 2000n, frozen: false });
    expect(observation.blockHeight).toBe(500n);
  });

  // THE case this function exists for. A settled or closed trade's account is
  // simply gone, and the reconciler must see that to write a terminal status.
  // It is also the only case that never reaches a verification error, because
  // there are no bytes to verify.
  it("reports a missing trade account as absent, not as a failure", async () => {
    // Deliberately NOT stubbing the verifier's rejection: the real one must
    // turn a non-existent account into absence, because that is the case a kit
    // account-not-found error used to escape as a transport failure.
    const { verifySwapDvpAccount: real } =
      await vi.importActual<typeof import("@sdp/dvp")>("@sdp/dvp");
    verifySwapDvpAccount.mockImplementation(real);
    fetchEncodedAccounts.mockResolvedValue([missing(SWAP), missing(ESCROW_A), missing(ESCROW_B)]);

    const observation = await readDvpTradeObservation(rpc, SWAP, legs, 500n);

    expect(observation.tradeAccountExists).toBe(false);
  });

  // Bytes that fail an owner or size check are a settled fact about the chain:
  // whatever is at that address, it is not a trade we would act on.
  it("reports unverifiable bytes as absent", async () => {
    fetchEncodedAccounts.mockResolvedValue([tradeAccount(), missing(ESCROW_A), missing(ESCROW_B)]);
    verifySwapDvpAccount.mockRejectedValue(
      new SwapDvpVerificationError("not owned by the DvP program")
    );

    const observation = await readDvpTradeObservation(rpc, SWAP, legs, 500n);

    expect(observation.tradeAccountExists).toBe(false);
  });

  // The opposite direction, and the more expensive mistake: a transport failure
  // reported as absence would terminalize a live trade irreversibly.
  it("propagates a transport failure instead of calling it absence", async () => {
    fetchEncodedAccounts.mockRejectedValue(new Error("fetch failed"));

    await expect(readDvpTradeObservation(rpc, SWAP, legs, 500n)).rejects.toThrow("fetch failed");
  });

  // Likewise for a decode that fails for a reason we did not anticipate: it is
  // not evidence of absence, so it must not be laundered into one.
  it("propagates an unexpected decode failure", async () => {
    fetchEncodedAccounts.mockResolvedValue([tradeAccount(), missing(ESCROW_A), missing(ESCROW_B)]);
    verifySwapDvpAccount.mockRejectedValue(new TypeError("unexpected"));

    await expect(readDvpTradeObservation(rpc, SWAP, legs, 500n)).rejects.toThrow("unexpected");
  });

  // Three accounts, one round trip. A second call would read the escrows at a
  // different slot than the trade, which is how you observe a half-settled
  // trade that never existed.
  it("reads the trade and both escrows in a single request", async () => {
    fetchEncodedAccounts.mockResolvedValue([tradeAccount(), missing(ESCROW_A), missing(ESCROW_B)]);

    await readDvpTradeObservation(rpc, SWAP, legs, 500n);

    expect(fetchEncodedAccounts).toHaveBeenCalledTimes(1);
    expect(fetchEncodedAccounts.mock.calls[0][1]).toEqual([SWAP, ESCROW_A, ESCROW_B]);
  });

  it("reports a frozen escrow", async () => {
    fetchEncodedAccounts.mockResolvedValue([
      tradeAccount(),
      tokenAccount(ESCROW_A, { amount: 1000n, frozen: true }),
      missing(ESCROW_B),
    ]);

    const observation = await readDvpTradeObservation(rpc, SWAP, legs, 500n);

    expect(observation.legA).toEqual({ exists: true, amount: 1000n, frozen: true });
  });

  // An address alone proves nothing. Reporting the bytes at a wrong-owner
  // address as a balance would be worse than reporting nothing.
  it("refuses to read an escrow owned by another program as a balance", async () => {
    fetchEncodedAccounts.mockResolvedValue([
      tradeAccount(),
      tokenAccount(ESCROW_A, { amount: 9999n }, "11111111111111111111111111111111" as Address),
      missing(ESCROW_B),
    ]);

    const observation = await readDvpTradeObservation(rpc, SWAP, legs, 500n);

    expect(observation.legA).toEqual({ exists: false, amount: 0n, frozen: false });
  });
});

describe("readEscrowState", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("reads a live escrow", async () => {
    fetchEncodedAccounts.mockResolvedValue([tokenAccount(ESCROW_A, { amount: 400n })]);

    await expect(readEscrowState(rpc, ESCROW_A, T22)).resolves.toEqual({
      amount: 400n,
      frozen: false,
    });
  });

  it("returns null for an escrow that is not on chain yet", async () => {
    fetchEncodedAccounts.mockResolvedValue([missing(ESCROW_A)]);

    await expect(readEscrowState(rpc, ESCROW_A, T22)).resolves.toBeNull();
  });
});
