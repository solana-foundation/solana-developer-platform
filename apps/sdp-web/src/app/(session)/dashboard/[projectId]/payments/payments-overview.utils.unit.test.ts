import type { CustodyWalletTokenBalance } from "@sdp/types/custody";
import { PAYMENT_TRANSFER_STATUS_TONE, PAYMENT_TRANSFER_STATUSES } from "@sdp/types/payments";
import { SOL_MINT, WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import type { BadgeVariant } from "@sdp/ui/badge";
import { describe, expect, it } from "vitest";
import {
  countUnpricedHoldings,
  formatTokenAmount,
  formatTotalBalance,
  isHttpUrl,
  normalizeAggregateBalances,
  resolveTokenByMint,
  resolveTotalBalance,
  resolveTransferTokenLabel,
  resolveUsdBalanceValue,
  resolveUsdUnitPrice,
  statusMessageKey,
  statusVariant,
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
  const cases = [
    ["pending", "DashboardPayments.transactions.pending"],
    ["processing", "DashboardPayments.transactions.processing"],
    ["confirmed", "DashboardPayments.transactions.confirmed"],
    ["finalized", "DashboardPayments.transactions.finalized"],
    ["failed", "DashboardPayments.transactions.failed"],
    ["awaiting_payment", "DashboardPayments.transactions.awaitingPayment"],
    ["settling", "DashboardPayments.transactions.settling"],
    ["completed", "DashboardPayments.transactions.completed"],
    ["canceled", "DashboardPayments.transactions.canceled"],
    ["expired", "DashboardPayments.transactions.expired"],
  ] satisfies ReadonlyArray<
    readonly [
      (typeof PAYMENT_TRANSFER_STATUSES)[number],
      `DashboardPayments.transactions.${string}`,
    ]
  >;

  it.each(cases)("maps %s to %s", (status, expected) => {
    expect(statusMessageKey(status)).toBe(expected);
  });
});

describe("statusVariant", () => {
  const expectedVariantByTone = {
    success: "success",
    pending: "warning",
    danger: "danger",
    neutral: "default",
  } satisfies Record<
    (typeof PAYMENT_TRANSFER_STATUS_TONE)[keyof typeof PAYMENT_TRANSFER_STATUS_TONE],
    BadgeVariant
  >;

  it.each(PAYMENT_TRANSFER_STATUSES)("maps %s through its status tone", (status) => {
    expect(statusVariant(status)).toBe(expectedVariantByTone[PAYMENT_TRANSFER_STATUS_TONE[status]]);
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

  it("keeps a holding with no price feed, which the total leaves out", () => {
    const unpriced: CustodyWalletTokenBalance = { ...issuedBalance, usdValue: undefined };
    const rows = normalizeAggregateBalances([solBalance, usdcBalance, unpriced]);
    expect(rows.map((row) => row.token)).toEqual(["USDC", "bSGD", "SOL"]);
    expect(resolveTotalBalance(rows)).toBe(375.25 + 100);
    expect(countUnpricedHoldings(rows)).toBe(1);
  });

  it("drops a row that holds nothing", () => {
    const spent: CustodyWalletTokenBalance = { ...usdcBalance, amount: "0", uiAmount: "0" };
    const rows = normalizeAggregateBalances([solBalance, spent]);
    expect(rows.map((row) => row.token)).toEqual(["SOL"]);
  });
});

describe("resolveTotalBalance", () => {
  // Off mainnet the API prices nothing, so SOL arrives without a USD value.
  const unpricedSol: CustodyWalletTokenBalance = {
    token: "SOL",
    mint: SOL_MINT,
    amount: "1000000000",
    uiAmount: "1",
    decimals: 9,
  };
  const spentUsdc: CustodyWalletTokenBalance = {
    token: "USDC",
    mint: WELL_KNOWN_TOKENS.USDC.mints.devnet.address,
    amount: "0",
    uiAmount: "0",
    decimals: 6,
  };

  it("has no dollar total for 1 SOL beside a spent USDC account, where it read $0.00", () => {
    expect(resolveTotalBalance([unpricedSol, spentUsdc])).toBeNull();
    expect(countUnpricedHoldings([unpricedSol, spentUsdc])).toBe(1);
  });

  it("is an honest $0.00 when the rows hold nothing", () => {
    const emptySol = { ...unpricedSol, amount: "0", uiAmount: "0" };
    expect(resolveTotalBalance([emptySol, spentUsdc])).toBe(0);
  });

  it("has no total when nothing was read", () => {
    expect(resolveTotalBalance([])).toBeNull();
  });

  it("sums the priced holdings and counts the others as unpriced", () => {
    const usdc = { ...spentUsdc, amount: "100000000", uiAmount: "100" };
    expect(resolveTotalBalance([unpricedSol, usdc])).toBe(100);
    expect(countUnpricedHoldings([unpricedSol, usdc])).toBe(1);
  });

  it("never prices a token by its symbol", () => {
    const spoofed: CustodyWalletTokenBalance = {
      token: "USDC",
      mint: UNCATALOGUED_MINT,
      amount: "1000000000000",
      uiAmount: "1000000",
      decimals: 6,
    };
    expect(resolveUsdBalanceValue(spoofed)).toBeNull();
    expect(resolveTotalBalance([spoofed])).toBeNull();
  });
});

describe("resolveUsdUnitPrice", () => {
  const sol: CustodyWalletTokenBalance = {
    token: "SOL",
    mint: SOL_MINT,
    amount: "1000000000",
    uiAmount: "1",
    decimals: 9,
  };

  it("reads the market price a balance row carried", () => {
    expect(resolveUsdUnitPrice(SOL_MINT, [{ ...sol, usdPrice: 150 }])).toBe(150);
  });

  it("values a well-known USD stablecoin at a dollar, held or not", () => {
    expect(resolveUsdUnitPrice(WELL_KNOWN_TOKENS.USDC.mints.devnet.address, [])).toBe(1);
  });

  it("has no price for a mint without one", () => {
    expect(resolveUsdUnitPrice(SOL_MINT, [sol])).toBeNull();
    expect(resolveUsdUnitPrice(UNCATALOGUED_MINT, [])).toBeNull();
  });
});

describe("formatTotalBalance", () => {
  it("shows a dash where there is no dollar total, and $0.00 only for a measured zero", () => {
    expect(formatTotalBalance(null, "en-US")).toBe("—");
    expect(formatTotalBalance(0, "en-US")).toBe("$0.00");
  });
});
