import type { CustodyWalletSummary } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { filterWallets } from "./wallet-search";

const wallets: CustodyWalletSummary[] = [
  {
    id: "wallet-row-1",
    provider: "privy",
    walletId: "privy_treasury_01",
    publicKey: "TreasuryPublicKey1111111111111111111111111",
    label: "Operations Treasury",
    purpose: "transfer",
    status: "active",
    createdAt: "2026-07-18T12:00:00.000Z",
  },
  {
    id: "wallet-row-2",
    provider: "coinbase_cdp",
    walletId: "coinbase_authority_02",
    publicKey: "MintAuthorityPublicKey222222222222222222222",
    label: "Primary Issuer",
    purpose: "mint_authority",
    status: "active",
    createdAt: "2026-07-18T12:00:00.000Z",
  },
];

describe("wallet search", () => {
  it("matches wallet labels, IDs, and addresses without case sensitivity", () => {
    expect(filterWallets(wallets, "OPERATIONS").map((wallet) => wallet.id)).toEqual([
      "wallet-row-1",
    ]);
    expect(filterWallets(wallets, "authority_02").map((wallet) => wallet.id)).toEqual([
      "wallet-row-2",
    ]);
    expect(filterWallets(wallets, "publickey111").map((wallet) => wallet.id)).toEqual([
      "wallet-row-1",
    ]);
  });

  it("supports multi-word provider and purpose searches", () => {
    expect(filterWallets(wallets, "coinbase mint authority").map((wallet) => wallet.id)).toEqual([
      "wallet-row-2",
    ]);
  });

  it("returns the full list after search is reset", () => {
    expect(filterWallets(wallets, "   ")).toEqual(wallets);
  });
});
