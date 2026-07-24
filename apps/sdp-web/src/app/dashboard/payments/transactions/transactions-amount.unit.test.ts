import { WELL_KNOWN_TOKENS } from "@sdp/types";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getTransactionAmountPresentation, TransactionAmount } from "./transactions-amount";

describe("transaction amount presentation", () => {
  it("uses the human symbol for a well-known mint", () => {
    expect(
      getTransactionAmountPresentation(
        { amount: "12.5", token: WELL_KNOWN_TOKENS.USDC.mints.devnet },
        "en-US"
      )
    ).toEqual({
      compacted: false,
      display: "12.50 USDC",
      full: "12.50 USDC",
    });
  });

  it("shortens an unknown mint while retaining the full accessible value", () => {
    const mint = "AbcdefghijkLmnoPqrstUvwxyz1234567890WXYZ";

    expect(getTransactionAmountPresentation({ amount: "1250", token: mint }, "en-US")).toEqual({
      compacted: true,
      display: "1,250 Abcdef…WXYZ",
      full: `1,250 ${mint}`,
    });

    const markup = renderToStaticMarkup(
      createElement(TransactionAmount, {
        transfer: {
          id: "transfer_1",
          status: "confirmed",
          signature: null,
          metadata: {},
          amount: "1250",
          token: mint,
        },
        locale: "en-US",
      })
    );
    expect(markup).toContain(`title="1,250 ${mint}"`);
    expect(markup).toContain(`<span class="sr-only">1,250 ${mint}</span>`);
    expect(markup).toContain('<span aria-hidden="true">1,250 Abcdef…WXYZ</span>');
  });

  it("leaves a short token symbol untouched", () => {
    expect(getTransactionAmountPresentation({ amount: "0.25", token: "E2EOPN" }, "en-US")).toEqual({
      compacted: false,
      display: "0.25 E2EOPN",
      full: "0.25 E2EOPN",
    });
  });
});
