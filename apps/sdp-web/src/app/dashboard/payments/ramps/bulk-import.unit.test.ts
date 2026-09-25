import { describe, expect, it } from "vitest";
import { bulkCsvTemplate, parseBulkCsv } from "./bulk-import";

describe("parseBulkCsv", () => {
  it("skips the template header, a byte-order mark and blank lines", () => {
    expect(
      parseBulkCsv(
        "﻿counterparty_wallet_id,currency_or_mint,amount\r\ncpa_1,usdc,10\r\n\r\ncpa_2,Mint111,2.5\r\n"
      )
    ).toEqual([
      { accountId: "cpa_1", currency: "USDC", amount: "10" },
      { accountId: "cpa_2", currency: "Mint111", amount: "2.5" },
    ]);
  });

  it("reads a file without a header as rows", () => {
    expect(parseBulkCsv("cpa_1, SOL, 1")).toEqual([
      { accountId: "cpa_1", currency: "SOL", amount: "1" },
    ]);
  });

  it("round-trips its own template", () => {
    expect(parseBulkCsv(bulkCsvTemplate())).toEqual([
      { accountId: "cpa_example123", currency: "USDC", amount: "25.00" },
    ]);
  });
});
