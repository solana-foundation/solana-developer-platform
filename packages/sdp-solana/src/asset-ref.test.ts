import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SOL_MINT, WELL_KNOWN_TOKENS, wellKnownMint } from "@sdp/types/well-known-tokens";
import { address, getAddressDecoder } from "@solana/kit";
import {
  ASSET_RESOLUTION_REFUSALS,
  AssetResolutionError,
  isSameAsset,
  NATIVE_ASSET,
  resolveAssetRequest,
} from "./asset-ref";

const UNKNOWN_MINT = getAddressDecoder().decode(new Uint8Array(32).fill(7));

function mintOf(symbol: "USDC" | "USDT" | "PYUSD", cluster: "devnet" | "mainnet-beta") {
  const mint = wellKnownMint(symbol, cluster);
  if (mint === undefined) throw new Error(`${symbol} has no ${cluster} mint`);
  return address(mint);
}

function refusal(reason: string) {
  return (error: unknown) => error instanceof AssetResolutionError && error.reason === reason;
}

describe("resolveAssetRequest", () => {
  it("resolves the SOL symbol, in any casing, to native SOL", () => {
    for (const token of ["SOL", "sol", " Sol "]) {
      assert.deepEqual(resolveAssetRequest(token, "devnet"), NATIVE_ASSET, token);
    }
  });

  // SOLA9-758 and SOLA9-838: the wrapped SOL mint must never move as lamports.
  it("resolves the wrapped SOL mint to an SPL token, not to native SOL", () => {
    assert.deepEqual(resolveAssetRequest(SOL_MINT, "mainnet-beta"), {
      kind: "token",
      mint: SOL_MINT,
      program: "spl-token",
    });
  });

  it("resolves a symbol to the cluster's mint and the catalogue's program", () => {
    assert.deepEqual(resolveAssetRequest("usdc", "devnet"), {
      kind: "token",
      mint: mintOf("USDC", "devnet"),
      program: "spl-token",
    });
    assert.deepEqual(resolveAssetRequest("USDC", "mainnet-beta"), {
      kind: "token",
      mint: mintOf("USDC", "mainnet-beta"),
      program: "spl-token",
    });
    assert.deepEqual(resolveAssetRequest("PYUSD", "mainnet-beta"), {
      kind: "token",
      mint: mintOf("PYUSD", "mainnet-beta"),
      program: WELL_KNOWN_TOKENS.PYUSD.tokenProgram,
    });
  });

  it("resolves a display-cased symbol through its catalogue key", () => {
    const resolved = resolveAssetRequest("JitoSOL", "mainnet-beta");
    assert.equal(resolved.kind, "token");
  });

  it("refuses a symbol the cluster does not deploy", () => {
    assert.throws(
      () => resolveAssetRequest("USDT", "devnet"),
      refusal(ASSET_RESOLUTION_REFUSALS.notOnCluster)
    );
  });

  it("resolves a catalogue mint address on its own cluster only", () => {
    const mainnetUsdt = mintOf("USDT", "mainnet-beta");
    assert.deepEqual(resolveAssetRequest(mainnetUsdt, "mainnet-beta"), {
      kind: "token",
      mint: mainnetUsdt,
      program: "spl-token",
    });
    assert.throws(
      () => resolveAssetRequest(mainnetUsdt, "devnet"),
      refusal(ASSET_RESOLUTION_REFUSALS.notOnCluster)
    );
  });

  it("leaves a mint outside the catalogue unread, with no program", () => {
    assert.deepEqual(resolveAssetRequest(` ${UNKNOWN_MINT} `, "devnet"), {
      kind: "mint",
      mint: UNKNOWN_MINT,
    });
  });

  it("refuses a string that is neither a symbol nor an address", () => {
    for (const token of ["", "DOGE", "not a mint", `${UNKNOWN_MINT}x`]) {
      assert.throws(
        () => resolveAssetRequest(token, "devnet"),
        refusal(ASSET_RESOLUTION_REFUSALS.invalidToken),
        token
      );
    }
  });
});

describe("isSameAsset", () => {
  const usdc = { kind: "token", mint: mintOf("USDC", "devnet"), program: "spl-token" } as const;

  it("matches native SOL only with native SOL", () => {
    assert.equal(isSameAsset(NATIVE_ASSET, NATIVE_ASSET), true);
    assert.equal(isSameAsset(NATIVE_ASSET, usdc), false);
    assert.equal(isSameAsset(usdc, NATIVE_ASSET), false);
  });

  it("matches a token on mint and program", () => {
    assert.equal(isSameAsset(usdc, { ...usdc }), true);
    assert.equal(isSameAsset(usdc, { ...usdc, program: "token-2022" }), false);
    assert.equal(isSameAsset(usdc, { ...usdc, mint: UNKNOWN_MINT }), false);
  });
});
