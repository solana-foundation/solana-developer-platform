import { type Address, address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { findDvpNonceTombstonePda } from "./pdas";

const ANY = address("So11111111111111111111111111111111111111112");
const OTHER = address("11111111111111111111111111111111") as Address;

describe("findDvpNonceTombstonePda", () => {
  // Pins the tombstone derivation to the deployed devnet program
  // (`dvp34bdb…`, see index.test.ts) and the seed scheme
  // `["nonce", swap_dvp]`. The address was derived once from that scheme;
  // re-derive by hand before changing either side — a moved seed or program
  // would otherwise keep these tests green while CreateDvp passes the
  // on-chain program an account it does not own.
  it("derives the pinned tombstone address for a trade", async () => {
    expect(await findDvpNonceTombstonePda(ANY)).toBe(
      "3L65RrMapzxGZZs1oYcuBXGLTTJq1HiYdq5eP65HNo8W"
    );
  });

  it("is deterministic — same trade always derives the same tombstone", async () => {
    const a = await findDvpNonceTombstonePda(ANY);
    const b = await findDvpNonceTombstonePda(ANY);

    expect(a).toBe(b);
  });

  it("differs across trades", async () => {
    const a = await findDvpNonceTombstonePda(ANY);
    const b = await findDvpNonceTombstonePda(OTHER);

    expect(a).not.toBe(b);
    expect(b).toBe("75CtByhiBqbwnSV6T1udsHLEj66XRj5AHT8NZ2MeTwVN");
  });
});
