"use client";

import { RAMPS_MEMO_LIMITS } from "@sdp/types";
import { PlusIcon, XIcon } from "lucide-react";
import { type ClipboardEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
import {
  emptyMemoRow,
  isEmptyMemoRow,
  type MemoRow,
  type MemoRowError,
  memoRowsToRecord,
  splitPastedMemoRows,
  validateMemoRows,
} from "../memo";

interface MemoDialogProps {
  open: boolean;
  memo: Record<string, string>;
  onClose: () => void;
  onSave: (memo: Record<string, string>) => void;
}

interface EditableMemoRow extends MemoRow {
  id: string;
}

const INPUT_CLASS =
  "h-10 w-full rounded-lg border border-border-default bg-[var(--input-bg-idle)] px-3 text-sm text-primary placeholder:text-tertiary hover:bg-[var(--input-bg-hover)] focus:border-[var(--input-border-focus)] focus:outline-none";

/**
 * Creates an editable memo row with stable render identity.
 *
 * @param row - The memo key and value.
 * @returns An editable memo row.
 */
function editableMemoRow(row: MemoRow): EditableMemoRow {
  return { ...row, id: crypto.randomUUID() };
}

/**
 * Renders the editable memo modal for ramp quote reconciliation fields.
 * Mounted only while open so each opening reseeds the grid from the saved
 * memo.
 *
 * @param props - Dialog visibility, saved memo, and close/save callbacks.
 * @returns The memo editing modal.
 */
export function MemoDialog({ open, memo, onClose, onSave }: MemoDialogProps) {
  const t = useTranslations();
  const [rows, setRows] = useState<EditableMemoRow[]>(() => {
    const savedRows = Object.entries(memo).map(([key, value]) => editableMemoRow({ key, value }));
    return savedRows.length === 0 ? [editableMemoRow(emptyMemoRow())] : savedRows;
  });
  const [errors, setErrors] = useState<MemoRowError[]>([]);

  const updateRow = (index: number, field: keyof MemoRow, value: string) => {
    setRows((current) =>
      current.map((row, rowIndex) => (rowIndex === index ? { ...row, [field]: value } : row))
    );
    setErrors([]);
  };

  const removeRow = (index: number) => {
    setRows((current) => {
      const remaining = current.filter((_, rowIndex) => rowIndex !== index);
      return remaining.length === 0 ? [editableMemoRow(emptyMemoRow())] : remaining;
    });
    setErrors([]);
  };

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const parsed = splitPastedMemoRows(event.clipboardData.getData("text"));
    if (parsed.length === 0) {
      return;
    }
    event.preventDefault();
    setRows((current) => {
      const populated = current.filter((row) => !isEmptyMemoRow(row));
      return [...populated, ...parsed.map(editableMemoRow)];
    });
    setErrors([]);
  };

  const handleSave = () => {
    const validationErrors = validateMemoRows(rows);
    if (validationErrors.length > 0) {
      setErrors(validationErrors);
      return;
    }
    onSave(memoRowsToRecord(rows));
    onClose();
  };

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      ariaLabel={t("DashboardPayments.ramps.memoDialogAriaLabel")}
      size="xl"
    >
      <div className="space-y-5 p-6">
        <div className="space-y-1">
          <p className="text-xl font-medium tracking-tight text-primary">
            {t("DashboardPayments.ramps.memoTitle")}
          </p>
          <p className="text-sm text-tertiary">{t("DashboardPayments.ramps.memoDescription")}</p>
        </div>

        <div className="grid grid-cols-[1fr_1fr_36px] gap-2 px-1 text-xs font-medium text-tertiary">
          <span>{t("DashboardPayments.ramps.memoKey")}</span>
          <span>{t("DashboardPayments.ramps.memoValue")}</span>
          <span />
        </div>

        <div className="max-h-80 space-y-2 overflow-y-auto">
          {rows.map((row, index) => {
            const rowErrors = errors.filter((error) => error.row === index + 1);
            return (
              <div key={row.id} className="grid grid-cols-[1fr_1fr_36px] items-start gap-2">
                <input
                  value={row.key}
                  onChange={(event) => updateRow(index, "key", event.currentTarget.value)}
                  onPaste={handlePaste}
                  placeholder={t("DashboardPayments.ramps.memoKeyPlaceholder")}
                  maxLength={RAMPS_MEMO_LIMITS.maxKeyLength}
                  aria-invalid={rowErrors.length > 0}
                  className={INPUT_CLASS}
                />
                <input
                  value={row.value}
                  onChange={(event) => updateRow(index, "value", event.currentTarget.value)}
                  onPaste={handlePaste}
                  placeholder={t("DashboardPayments.ramps.memoValuePlaceholder")}
                  maxLength={RAMPS_MEMO_LIMITS.maxValueLength}
                  aria-invalid={rowErrors.length > 0}
                  className={INPUT_CLASS}
                />
                <button
                  type="button"
                  onClick={() => removeRow(index)}
                  aria-label={t("DashboardPayments.ramps.removeMemoRow", { row: index + 1 })}
                  className="flex size-9 items-center justify-center rounded-lg text-tertiary transition-colors hover:bg-fill-subtle hover:text-primary"
                >
                  <XIcon className="size-4" />
                </button>
                {rowErrors.length > 0 ? (
                  <div className="col-span-3 space-y-1 text-xs text-error">
                    {rowErrors.map((error) => (
                      <p key={error.message}>{error.message}</p>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <button
          type="button"
          onClick={() => setRows((current) => [...current, editableMemoRow(emptyMemoRow())])}
          disabled={rows.length >= RAMPS_MEMO_LIMITS.maxEntries}
          className="flex items-center gap-1.5 text-sm font-medium text-tertiary transition-colors hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          <PlusIcon className="size-4" />
          {t("DashboardPayments.ramps.addMemoRow")}
        </button>

        {errors.some((error) => error.row === 0) ? (
          <div className="rounded-xl border border-error-border bg-error-bg px-4 py-3 text-sm text-error">
            {errors
              .filter((error) => error.row === 0)
              .map((error) => (
                <p key={error.message}>{error.message}</p>
              ))}
          </div>
        ) : null}

        <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("DashboardPayments.ramps.memoCancel")}
          </Button>
          <Button type="button" onClick={handleSave}>
            {t("DashboardPayments.ramps.memoSave")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
