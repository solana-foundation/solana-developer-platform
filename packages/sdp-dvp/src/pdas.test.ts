import { type Address, address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { DVP_SWAP_PROGRAM_PROGRAM_ADDRESS } from "./generated/programs/dvpSwapProgram";
import { findDvpNonceTombstonePda } from "./pdas";

const ANY = address("So11111111111111111111111111111111111111112");

// The derivation the tombstone contract depends on, restated from the spec so a
// seed, seed-order or program change in pdas.ts is caught here rather than
// silently moving where tombstones live. The helper under test must agree with
// this independent recomputation, not merely with determinism.
async function expectedTombstonePda(swapDvp: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: DVP_SWAP_PROGRAM_PROGRAM_ADDRESS,
    seeds: [new TextEncoder().encode("nonce"), getAddressEncoder().encode(swapDvp)],
  });
  return pda;
}

describe("findDvpNonceTombstonePda", () => {
  it('derives the documented tombstone PDA: ["nonce", trade] under the DvP program', async () => {
    const pda = await findDvpNonceTombstonePda(ANY);

    expect(pda).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(pda).toBe(await expectedTombstonePda(ANY));
  });

  it("is deterministic — same trade always derives the same tombstone", async () => {
    const a = await findDvpNonceTombstonePda(ANY);
    const b = await findDvpNonceTombstonePda(ANY);

    expect(a).toBe(b);
    expect(a).toBe(await expectedTombstonePda(ANY));
  });

  it("differs across trades", async () => {
    const other = address("11111111111111111111111111111111") as Address;
    const a = await findDvpNonceTombstonePda(ANY);
    const b = await findDvpNonceTombstonePda(other);

    expect(a).not.toBe(b);
    expect(b).toBe(await expectedTombstonePda(other));
  });
});
