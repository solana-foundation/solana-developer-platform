/**
 * Reading a mint for the create form.
 *
 * The account data below is REAL, captured from the two mints this actually has
 * to work on: a Token-2022 mint carrying an inline metadata extension, and
 * legacy USDC. A hand-written byte fixture would only prove the decoder agrees
 * with whatever this file invented, which is the failure mode these tests
 * exist to avoid.
 */

import { describe, expect, it } from "vitest";

/** An RPC whose `getAccountInfo` returns the given wire-format account. */
function rpcReturning(account: { owner: string; data: string } | null) {
  return {
    getAccountInfo: () => ({
      send: async () => ({
        value:
          account === null
            ? null
            : {
                owner: account.owner,
                data: [account.data, "base64"],
                lamports: 1n,
                executable: false,
                space: 0n,
              },
      }),
    }),
  } as never;
}

const { inspectDvpMint } = await import("./inspect-mint");

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const LEGACY_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** Acme Treasury Dollar, 6 decimals, MetadataPointer + TokenMetadata. */
const ATD_MINT = "BmA22WnK8p5Ai5mkzJhk64DCxMiUiii69tgSmUGMWPSh";
const ATD_DATA =
  "AQAAAIr6zx+zfRwM97nb/ZUtRD0Q80kbSiS0vabQe24HyhB/ALod0gUAAAAGAQAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARIAQACK+s8fs30cDPe52/2VLUQ9EPNJG0oktL2m0HtuB8oQf5" +
  "/knwbjg6R/Q1GAnIOFrQl2QUtQa3CbAM9VOc+krWjSEwCDAIr6zx+zfRwM97nb/ZUtRD0Q80kbSiS0vabQe24HyhB/" +
  "n+SfBuODpH9DUYCcg4WtCXZBS1BrcJsAz1U5z6StaNIUAAAAQWNtZSBUcmVhc3VyeSBEb2xsYXIDAAAAQVREHAAAAG" +
  "h0dHBzOi8vZXhhbXBsZS5jb20vYXRkLmpzb24AAAAA";

/** Devnet USDC, 6 decimals, legacy program, no extensions at all. */
const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const USDC_DATA =
  "AQAAAOuFRM+RGCd6ljLpmVBmZRu/sUCLhXPrwC5T76tavw4LarmQohVIBuIGAQEAAACoBjP/Bn2I36XUNXv0TibOzM" +
  "8IZmiBA8a6YJ+kTBjSCA==";

describe("inspectDvpMint", () => {
  it("reads decimals and inline metadata from a Token-2022 mint", async () => {
    const rpc = rpcReturning({ owner: TOKEN_2022, data: ATD_DATA });

    await expect(inspectDvpMint(rpc, ATD_MINT as never)).resolves.toMatchObject({
      decimals: 6,
      name: "Acme Treasury Dollar",
      symbol: "ATD",
      tokenProgram: TOKEN_2022,
      eligible: true,
      blockedBy: null,
    });
  });

  // The whole point: a pasted mint can now offer a human amount, because its
  // decimals are one account read away rather than unknowable client-side.
  it("reads decimals from a legacy mint that carries no extensions", async () => {
    const rpc = rpcReturning({ owner: LEGACY_TOKEN, data: USDC_DATA });

    await expect(inspectDvpMint(rpc, USDC_MINT as never)).resolves.toMatchObject({
      decimals: 6,
      tokenProgram: LEGACY_TOKEN,
      eligible: true,
    });
  });

  // A legacy mint has no extensions by construction, so there is no metadata to
  // find and the form falls back to the address rather than inventing a label.
  it("reports no name for a mint with no metadata extension", async () => {
    const rpc = rpcReturning({ owner: LEGACY_TOKEN, data: USDC_DATA });

    const result = await inspectDvpMint(rpc, USDC_MINT as never);

    expect(result?.name).toBeNull();
    expect(result?.symbol).toBeNull();
  });

  describe("refuses to guess", () => {
    it("returns null when nothing is at the address", async () => {
      const rpc = rpcReturning(null);

      await expect(inspectDvpMint(rpc, ATD_MINT as never)).resolves.toBeNull();
    });

    // A wallet, a program, any non-mint account. Decoding it anyway would put a
    // confident wrong decimals in front of someone about to enter an amount.
    it("returns null when the account is not owned by a token program", async () => {
      const rpc = rpcReturning({ owner: "11111111111111111111111111111111", data: ATD_DATA });

      await expect(inspectDvpMint(rpc, ATD_MINT as never)).resolves.toBeNull();
    });

    it("returns null when the data does not decode as a mint", async () => {
      const rpc = rpcReturning({ owner: TOKEN_2022, data: "AAAA" });

      await expect(inspectDvpMint(rpc, ATD_MINT as never)).resolves.toBeNull();
    });
  });
});
