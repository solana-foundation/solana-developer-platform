import { describe, expect, it } from "vitest";
import { explorerAddressUrl, explorerTxUrl } from "./explorer";

describe("explorerTxUrl", () => {
  it("appends the cluster query for devnet", () => {
    expect(explorerTxUrl("5sig", "devnet")).toBe(
      "https://explorer.solana.com/tx/5sig?cluster=devnet"
    );
  });

  it("omits the cluster query for mainnet-beta (explorer default)", () => {
    expect(explorerTxUrl("5sig", "mainnet-beta")).toBe("https://explorer.solana.com/tx/5sig");
  });

  it("encodes the signature", () => {
    expect(explorerTxUrl("a/b c", "devnet")).toBe(
      "https://explorer.solana.com/tx/a%2Fb%20c?cluster=devnet"
    );
  });
});

describe("explorerAddressUrl", () => {
  it("appends the cluster query for devnet", () => {
    expect(explorerAddressUrl("addr", "devnet")).toBe(
      "https://explorer.solana.com/address/addr?cluster=devnet"
    );
  });

  it("omits the cluster query for mainnet-beta", () => {
    expect(explorerAddressUrl("addr", "mainnet-beta")).toBe(
      "https://explorer.solana.com/address/addr"
    );
  });

  it("encodes the address", () => {
    expect(explorerAddressUrl("a/b", "devnet")).toBe(
      "https://explorer.solana.com/address/a%2Fb?cluster=devnet"
    );
  });
});
