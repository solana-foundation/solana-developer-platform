import { SOL_MINT } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { type BulkImportRow, firstDuplicateAccountId, validateBulkRows } from "./bulk-import";

function row(accountId: string, amount: string): BulkImportRow {
  return { accountId, currency: SOL_MINT, amount };
}

describe("validateBulkRows duplicate account rows", () => {
  it("flags a repeated account id as a row-specific error instead of accepting both rows", () => {
    const { valid, errors } = validateBulkRows([row("acct-1", "0.1"), row("acct-1", "0.2")]);

    expect(errors).toEqual([
      { row: 2, message: "Duplicate counterparty_wallet_id", duplicateAccountId: "acct-1" },
    ]);
    expect(valid).toEqual([row("acct-1", "0.1")]);
  });

  it("keeps every row whose account id appears only once", () => {
    const rows = [row("acct-1", "0.1"), row("acct-2", "0.2"), row("acct-1", "0.3")];
    const { valid, errors } = validateBulkRows(rows);

    expect(errors).toEqual([
      { row: 3, message: "Duplicate counterparty_wallet_id", duplicateAccountId: "acct-1" },
    ]);
    expect(valid).toEqual([rows[0], rows[1]]);
  });

  it("does not count a duplicate against a row that already failed another check", () => {
    const rows = [row("acct-1", "not-a-number"), row("acct-1", "0.2")];
    const { valid, errors } = validateBulkRows(rows);

    expect(errors).toEqual([{ row: 1, message: "Amount must be a positive number" }]);
    expect(valid).toEqual([rows[1]]);
  });

  it("still reports the existing row errors alongside duplicates", () => {
    const rows = [
      { accountId: "", currency: SOL_MINT, amount: "0.1" },
      row("acct-1", "0.1"),
      row("acct-1", "0.2"),
    ];
    const { valid, errors } = validateBulkRows(rows);

    expect(errors).toEqual([
      { row: 1, message: "Missing counterparty_wallet_id" },
      { row: 3, message: "Duplicate counterparty_wallet_id", duplicateAccountId: "acct-1" },
    ]);
    expect(valid).toEqual([rows[1]]);
  });
});

describe("firstDuplicateAccountId", () => {
  it("returns the first id that appears on more than one row", () => {
    expect(firstDuplicateAccountId([row("a", "1"), row("b", "1"), row("a", "2")])).toBe("a");
  });

  it("returns null when every account id is unique", () => {
    expect(firstDuplicateAccountId([row("a", "1"), row("b", "1")])).toBeNull();
  });
});
