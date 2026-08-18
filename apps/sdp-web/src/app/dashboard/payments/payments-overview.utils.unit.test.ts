import { type CustodyWalletTokenBalance, SOL_MINT, WELL_KNOWN_TOKENS } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  formatTokenAmount,
  isHttpUrl,
  normalizeAggregateBalances,
  resolveTokenByMint,
  resolveTotalBalance,
  resolveTransferTokenLabel,
  statusMessageKey,
} from "./payments-overview.utils";

const UNCATALOGUED_MINT = "BmA22WnK8p5Ai5mkzJhk64DCxMiUiii69tgSmUGMWPSh";

// Intl groups with a no-break space in French; match both forms it may emit.
const normalizeSpaces = (value: string) => value.replace(/[\xa0\u202f]/g, " ");

describe("resolveTransferTokenLabel", () => {
  it("resolves a well-known mint to its symbol", () => {
    expect(resolveTransferTokenLabel(WELL_KNOWN_TOKENS.USDC.mints.devnet.address)).toBe("USDC");
    expect(resolveTransferTokenLabel(WELL_KNOWN_TOKENS.USDT.mints["mainnet-beta"].address)).toBe(
      "USDT"
    );
  });

  it("shortens a mint it cannot name", () => {
    expect(resolveTransferTokenLabel(UNCATALOGUED_MINT)).toBe("BmA22W…WPSh");
  });

  it("prefers a caller-supplied symbol over shortening", () => {
    expect(resolveTransferTokenLabel(UNCATALOGUED_MINT, { [UNCATALOGUED_MINT]: "ATD" })).toBe(
      "ATD"
    );
  });

  it("ignores a supplied symbol that is just the mint repeated", () => {
    // The balances payload echoes the mint when it has no symbol for a token;
    // treating that as a name would defeat the shortened-address fallback.
    expect(
      resolveTransferTokenLabel(UNCATALOGUED_MINT, { [UNCATALOGUED_MINT]: UNCATALOGUED_MINT })
    ).toBe("BmA22W…WPSh");
  });

  it("keeps the catalogue authoritative for well-known mints", () => {
    const usdc = WELL_KNOWN_TOKENS.USDC.mints.devnet.address;

    expect(resolveTransferTokenLabel(usdc, { [usdc]: usdc })).toBe("USDC");
  });

  it("returns undefined for a missing or blank token", () => {
    expect(resolveTransferTokenLabel(null)).toBeUndefined();
    expect(resolveTransferTokenLabel(undefined)).toBeUndefined();
    expect(resolveTransferTokenLabel("   ")).toBeUndefined();
  });

  it("leaves a short non-mint ticker alone", () => {
    expect(resolveTransferTokenLabel("SOL")).toBe("SOL");
  });
});

describe("resolveTokenByMint", () => {
  it("maps the native SOL alias to the SOL mint", () => {
    // Rows written by the native send path record the literal "SOL".
    expect(resolveTokenByMint("SOL", {})).toMatchObject({
      mint: SOL_MINT,
      tokenName: "SOL",
      isWellKnown: true,
      tokenId: null,
    });
  });

  it("resolves an issued mint to its id, symbol, and metadata image", () => {
    const issued = {
      id: "tok_1",
      mintAddress: UNCATALOGUED_MINT,
      symbol: "bSGD",
      imageUrl: "https://cdn.example/bsgd.png",
    };

    expect(resolveTokenByMint(UNCATALOGUED_MINT, { [UNCATALOGUED_MINT]: issued })).toMatchObject({
      tokenId: "tok_1",
      tokenName: "bSGD",
      metadataImageUrl: "https://cdn.example/bsgd.png",
      isWellKnown: false,
    });
  });
});

describe("formatTokenAmount", () => {
  it("groups English amounts with commas and a dot decimal", () => {
    expect(formatTokenAmount("1234567.89", "en")).toBe("1,234,567.89");
  });

  it("groups French amounts with spaces and a comma decimal", () => {
    expect(normalizeSpaces(formatTokenAmount("1234567.89", "fr"))).toBe("1 234 567,89");
  });

  it("keeps every input digit on high-precision amounts", () => {
    expect(formatTokenAmount("123456789.123456789", "en")).toBe("123,456,789.123456789");
  });

  it("preserves the sign on fractional negative amounts", () => {
    expect(formatTokenAmount("-0.5", "en")).toBe("-0.5");
  });

  it("returns non-numeric input unchanged", () => {
    expect(formatTokenAmount("not-a-number", "fr")).toBe("not-a-number");
  });
});

describe("isHttpUrl", () => {
  it("accepts http and https URLs", () => {
    expect(isHttpUrl("https://example.com/metadata.json")).toBe(true);
    expect(isHttpUrl("http://localhost:3000/metadata.json")).toBe(true);
  });

  it("rejects executable and non-http schemes that must never reach an href", () => {
    expect(isHttpUrl("javascript:alert(document.domain)")).toBe(false);
    expect(isHttpUrl("data:text/html,<script>1</script>")).toBe(false);
    expect(isHttpUrl("vbscript:msgbox(1)")).toBe(false);
    expect(isHttpUrl("file:///etc/passwd")).toBe(false);
  });

  it("rejects unparseable values", () => {
    expect(isHttpUrl("not-a-url")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
  });
});

describe("statusMessageKey", () => {
  it("maps known statuses to the transactions catalog keys", () => {
    expect(statusMessageKey("failed")).toBe("DashboardPayments.transactions.failed");
    expect(statusMessageKey("awaiting_payment")).toBe(
      "DashboardPayments.transactions.awaitingPayment"
    );
  });

  it("returns null for a status the catalog does not name", () => {
    expect(statusMessageKey("some_new_status")).toBeNull();
  });
});

describe("normalizeAggregateBalances", () => {
  const solBalance: CustodyWalletTokenBalance = {
    token: "SOL",
    mint: SOL_MINT,
    amount: "2500000000",
    uiAmount: "2.5",
    decimals: 9,
    usdValue: 375.25,
  };
  const usdcBalance: CustodyWalletTokenBalance = {
    token: "USDC",
    mint: WELL_KNOWN_TOKENS.USDC.mints["mainnet-beta"].address,
    amount: "100000000",
    uiAmount: "100",
    decimals: 6,
  };
  const issuedBalance: CustodyWalletTokenBalance = {
    token: "bSGD",
    mint: UNCATALOGUED_MINT,
    amount: "50000000",
    uiAmount: "50",
    decimals: 6,
    usdValue: 37.5,
  };

  it("keeps native SOL as a row alongside SPL tokens", () => {
    const rows = normalizeAggregateBalances([solBalance, usdcBalance, issuedBalance]);
    expect(rows.map((row) => row.token)).toEqual(["USDC", "bSGD", "SOL"]);
  });

  it("counts SOL in the total balance", () => {
    const rows = normalizeAggregateBalances([solBalance, usdcBalance, issuedBalance]);
    expect(resolveTotalBalance(rows)).toBe(375.25 + 100 + 37.5);
  });

  it("still drops balances the API could not price", () => {
    const unpriced: CustodyWalletTokenBalance = { ...issuedBalance, usdValue: undefined };
    const rows = normalizeAggregateBalances([solBalance, usdcBalance, unpriced]);
    expect(rows.map((row) => row.token)).toEqual(["USDC", "SOL"]);
  });
});
