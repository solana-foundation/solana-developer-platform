import { isWellKnownTokenSymbol } from "@sdp/types";
import type { MessageKey, TranslationValues } from "@/i18n/messages";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

export interface BulkImportRow {
  accountId: string;
  currency: string;
  amount: string;
}

export interface BulkRowError {
  row: number;
  message: string;
  /** Set for duplicate-account errors: the id already claimed by an earlier row. */
  duplicateAccountId?: string;
}

export function emptyBulkRow(): BulkImportRow {
  return { accountId: "", currency: "", amount: "" };
}

export function isEmptyBulkRow(row: BulkImportRow): boolean {
  return row.accountId === "" && row.currency === "" && row.amount === "";
}

/** Split pasted text (one `wallet_id, currency_or_mint, amount` per line) into rows. */
export function splitPastedRows(text: string): BulkImportRow[] {
  return text
    .split("\n")
    .map((line) => line.split(",").map((part) => part.trim()))
    .filter((parts) => parts.length >= 3 && parts[0].length > 0)
    .map((parts) => {
      const upper = parts[1].toUpperCase();
      return {
        accountId: parts[0],
        currency: isWellKnownTokenSymbol(upper) ? upper : parts[1],
        amount: parts[2],
      };
    });
}

export function validateBulkRows(rows: BulkImportRow[]): {
  valid: BulkImportRow[];
  errors: BulkRowError[];
} {
  const valid: BulkImportRow[] = [];
  const errors: BulkRowError[] = [];
  const seenAccountIds = new Set<string>();

  rows.forEach((row, index) => {
    if (isEmptyBulkRow(row)) {
      return;
    }
    const line = index + 1;
    if (row.accountId.length === 0) {
      errors.push({ row: line, message: "Missing counterparty_wallet_id" });
      return;
    }
    if (row.currency.length === 0) {
      errors.push({ row: line, message: "Missing currency or mint address" });
      return;
    }
    const amount = Number(row.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      errors.push({ row: line, message: "Amount must be a positive number" });
      return;
    }
    // One leg per account: the wizard keys batches by account id, so a
    // repeated id would silently overwrite the earlier row's amount and drop
    // that transfer leg. Refuse it here, where the operator can fix the row.
    if (seenAccountIds.has(row.accountId)) {
      errors.push({
        row: line,
        message: "Duplicate counterparty_wallet_id",
        duplicateAccountId: row.accountId,
      });
      return;
    }
    seenAccountIds.add(row.accountId);
    valid.push(row);
  });

  return { valid, errors };
}

/**
 * The first account id that appears on more than one row, if any. The wizard
 * stores one entry per account id, so importing the same id twice would
 * silently overwrite the earlier amount and drop that transfer leg.
 */
export function firstDuplicateAccountId(rows: BulkImportRow[]): string | null {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.accountId)) {
      return row.accountId;
    }
    seen.add(row.accountId);
  }
  return null;
}

/**
 * Batch wizard entries are keyed by account id, so two rows for the same
 * account would silently overwrite the earlier amount and drop that transfer
 * leg. Throws a translated error so callers refuse the import before any
 * wizard state is mutated.
 */
export function assertDistinctAccountIds(rows: BulkImportRow[], t: Translate): void {
  const duplicateAccountId = firstDuplicateAccountId(rows);
  if (duplicateAccountId !== null) {
    throw new Error(
      t("DashboardPayments.batchSend.importDuplicateWallet", { id: duplicateAccountId })
    );
  }
}
