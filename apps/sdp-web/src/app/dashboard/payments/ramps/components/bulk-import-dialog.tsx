"use client";

import { PlusIcon, XIcon } from "lucide-react";
import { type ClipboardEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
import {
  type BulkImportRow,
  emptyBulkRow,
  isEmptyBulkRow,
  splitPastedRows,
  validateBulkRows,
} from "../bulk-import";

interface BulkImportDialogProps {
  open: boolean;
  onClose: () => void;
  onImport: (rows: BulkImportRow[]) => Promise<{ unresolved: string[] }>;
}

const INPUT_CLASS =
  "h-10 w-full rounded-lg border border-border-default bg-[var(--input-bg-idle)] px-3 text-sm text-primary placeholder:text-tertiary focus:border-[var(--input-border-focus)] focus:outline-none";

export function BulkImportDialog({ open, onClose, onImport }: BulkImportDialogProps) {
  const t = useTranslations();
  const [rows, setRows] = useState<BulkImportRow[]>([emptyBulkRow()]);
  const [errors, setErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const handleClose = () => {
    setRows([emptyBulkRow()]);
    setErrors([]);
    onClose();
  };

  const updateRow = (index: number, field: keyof BulkImportRow, value: string) => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  };

  const removeRow = (index: number) => {
    setRows((prev) => {
      const next = prev.filter((_, i) => i !== index);
      return next.length > 0 ? next : [emptyBulkRow()];
    });
  };

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const parsed = splitPastedRows(event.clipboardData.getData("text"));
    if (parsed.length === 0) {
      return;
    }
    event.preventDefault();
    setRows((prev) => {
      const kept = prev.filter((row) => !isEmptyBulkRow(row));
      return [...kept, ...parsed];
    });
  };

  const handleImport = async () => {
    const { valid, errors: rowErrors } = validateBulkRows(rows);
    const messages = rowErrors.map((error) =>
      t("DashboardPayments.batchSend.rowError", { row: error.row, message: error.message })
    );
    if (valid.length === 0 && messages.length === 0) {
      setErrors([t("DashboardPayments.batchSend.addAtLeastOneRecipient")]);
      return;
    }
    const currencies = [...new Set(valid.map((row) => row.currency))];
    if (currencies.length > 1) {
      messages.push(
        t("DashboardPayments.batchSend.oneCurrencyRequired", { currencies: currencies.join(", ") })
      );
    }
    if (messages.length > 0) {
      setErrors(messages);
      return;
    }

    setSubmitting(true);
    try {
      const { unresolved } = await onImport(valid);
      if (unresolved.length > 0) {
        setErrors(unresolved.map((id) => t("DashboardPayments.batchSend.walletNotFound", { id })));
        return;
      }
      handleClose();
    } catch (error) {
      setErrors([
        error instanceof Error ? error.message : t("DashboardPayments.batchSend.importFailed"),
      ]);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={open}
      onClose={handleClose}
      ariaLabel={t("DashboardPayments.batchSend.bulkImportAriaLabel")}
      size="xl"
    >
      <div className="space-y-5 p-6">
        <div className="space-y-1">
          <p className="text-xl font-medium tracking-tight text-primary">
            {t("DashboardPayments.batchSend.bulkImportTitle")}
          </p>
          <p className="text-sm text-tertiary">
            {t("DashboardPayments.batchSend.bulkImportDescriptionBefore")}
            <span className="font-mono">{t("DashboardPayments.batchSend.bulkImportFields")}</span>
            {t("DashboardPayments.batchSend.bulkImportDescriptionAfter")}
          </p>
        </div>

        <div className="max-h-80 space-y-2 overflow-y-auto">
          {rows.map((row, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional, identity is the index
            <div key={index} className="grid grid-cols-[1fr_120px_120px_36px] items-center gap-2">
              <input
                value={row.accountId}
                onChange={(event) => updateRow(index, "accountId", event.currentTarget.value)}
                onPaste={handlePaste}
                placeholder={t("DashboardPayments.batchSend.counterpartyWalletIdPlaceholder")}
                className={INPUT_CLASS}
              />
              <input
                value={row.currency}
                onChange={(event) => updateRow(index, "currency", event.currentTarget.value)}
                onPaste={handlePaste}
                placeholder={t("DashboardPayments.batchSend.currencyOrMintPlaceholder")}
                className={INPUT_CLASS}
              />
              <input
                value={row.amount}
                onChange={(event) => updateRow(index, "amount", event.currentTarget.value)}
                onPaste={handlePaste}
                placeholder={t("DashboardPayments.batchSend.amountPlaceholder")}
                inputMode="decimal"
                className={INPUT_CLASS}
              />
              <button
                type="button"
                onClick={() => removeRow(index)}
                aria-label={t("DashboardPayments.batchSend.removeRow", { row: index + 1 })}
                className="flex size-9 items-center justify-center rounded-lg text-tertiary transition-colors hover:bg-fill-subtle hover:text-primary"
              >
                <XIcon className="size-4" />
              </button>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setRows((prev) => [...prev, emptyBulkRow()])}
          className="flex items-center gap-1.5 text-sm font-medium text-tertiary transition-colors hover:text-primary"
        >
          <PlusIcon className="size-4" />
          {t("DashboardPayments.batchSend.addRecipientRow")}
        </button>

        {errors.length > 0 ? (
          <div className="space-y-1 rounded-xl border border-error-border bg-error-bg px-4 py-3 text-sm text-error">
            {errors.map((message, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: error list is positional; messages may repeat
              <p key={index}>{message}</p>
            ))}
          </div>
        ) : null}

        <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" onClick={handleClose} disabled={submitting}>
            {t("DashboardPayments.batchSend.cancel")}
          </Button>
          <Button type="button" onClick={() => void handleImport()} disabled={submitting}>
            {submitting
              ? t("DashboardPayments.batchSend.importing")
              : t("DashboardPayments.batchSend.import")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
