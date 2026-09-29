import { describe, expect, it } from "vitest";
import { bulkCsvTemplate, parseBulkCsv, validateBulkRows } from "./bulk-import";

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

describe("validateBulkRows", () => {
  it("refuses a second row for an account instead of keeping only its last amount", () => {
    const { valid, errors } = validateBulkRows([
      { accountId: "cpa_1", currency: "USDC", amount: "10" },
      { accountId: "cpa_2", currency: "USDC", amount: "5" },
      { accountId: "cpa_1", currency: "USDC", amount: "7" },
    ]);
    expect(valid.map((row) => row.accountId)).toEqual(["cpa_1", "cpa_2"]);
    expect(errors).toEqual([{ row: 3, message: "cpa_1 is already on row 1" }]);
  });
});
