import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import { tokenUnitsEntry } from "@/test/token-amount-entry";
import { TokenAmountQuotePreview } from "./token-amount-entry-controls";
import type { TokenAmountEntry } from "./use-token-amount-entry";

const feeEntry = { epoch: "700", basisPoints: 100, maximumFee: "5" };

/** A send of 100 token units of an interest-bearing mint with a 1% transfer fee. */
const accruingSend: TokenAmountEntry = {
  ...tokenUnitsEntry("100"),
  terms: {
    mint: "mint",
    decimals: 6,
    transferFee: { current: feeEntry, next: feeEntry },
    display: {
      rule: "interest",
      currentRate: 500,
      preUpdateAverageRate: 500,
      initializedAt: "2026-01-01T00:00:00.000Z",
      lastUpdateAt: "2026-01-01T00:00:00.000Z",
    },
  },
  displayEntryAvailable: true,
  quote: {
    mint: "mint",
    amount: "100",
    amounts: {
      basis: "debit",
      debit: "100",
      fee: "1",
      credit: "99",
      decimals: 6,
      display: { debit: "104.1", fee: "1.041", credit: "103.059", asOf: "2026-10-22T12:00:00Z" },
    },
    feeEpoch: "700",
    asOf: "2026-10-22T12:00:00Z",
    expiresAt: "2026-10-22T12:01:00Z",
  },
};

function markup(entry: TokenAmountEntry): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <TokenAmountQuotePreview entry={entry} symbol="USDX" />
    </I18nProvider>
  );
}

describe("TokenAmountQuotePreview", () => {
  it("shows the fee and what the recipient receives, in token units", () => {
    const html = markup(accruingSend);

    expect(html).toContain("Transfer fee");
    expect(html).toContain("1 USDX");
    expect(html).toContain("Recipient receives");
    expect(html).toContain("99 USDX");
    // A token-unit entry needs no converted amount row.
    expect(html).not.toContain("Token amount");
  });

  it("shows the recipient's display value as approximate for an interest-bearing mint", () => {
    expect(markup(accruingSend)).toContain("≈ 103.059 USDX");
  });

  it("names the token amount a display entry converts to", () => {
    const html = markup({ ...accruingSend, unit: "display", tokenAmount: "100" });

    expect(html).toContain("Token amount");
    expect(html).toContain("100 USDX");
  });

  it("shows nothing for a classic token", () => {
    expect(markup(tokenUnitsEntry("5"))).toBe("");
  });
});
