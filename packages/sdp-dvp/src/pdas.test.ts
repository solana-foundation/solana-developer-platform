import { type Address, address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { findDvpNonceTombstonePda } from "./pdas";

const ANY = address("So11111111111111111111111111111111111111112");

describe("findDvpNonceTombstonePda", () => {
  it("derives a canonical PDA for a trade address", async () => {
    const pda = await findDvpNonceTombstonePda(ANY);

    expect(pda).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it("is deterministic — same trade always derives the same tombstone", async () => {
    const a = await findDvpNonceTombstonePda(ANY);
    const b = await findDvpNonceTombstonePda(ANY);

    expect(a).toBe(b);
  });

  it("differs across trades", async () => {
    const other = address("11111111111111111111111111111111") as Address;
    const a = await findDvpNonceTombstonePda(ANY);
    const b = await findDvpNonceTombstonePda(other);

    expect(a).not.toBe(b);
  });
});
