"use client";

import { RAMPS_MEMO_LIMITS } from "@sdp/types";
import { PlusIcon, XIcon } from "lucide-react";
import { type ClipboardEvent, useState } from "react";
import { useTranslations } from "@/i18n/provider";
import {
  emptyMemoRow,
  isEmptyMemoRow,
  type MemoRow,
  type MemoRowErrorCode,
  memoRowsToRecord,
  splitPastedMemoRows,
  validateMemoRows,
} from "../memo";

interface MemoStepContentProps {
  rows: MemoRow[];
  onChange: (rows: MemoRow[]) => void;
}

interface EditableMemoRow extends MemoRow {
  id: string;
}

const INPUT_CLASS =
  "h-[var(--input-height-xl)] min-w-0 flex-1 rounded-[var(--input-radius-xl)] border border-border-default bg-[var(--input-bg-idle)] px-[var(--input-padding-x-xl)] text-base text-primary placeholder:text-tertiary hover:bg-[var(--input-bg-hover)] focus:border-[var(--input-border-focus)] focus:outline-none";

/**
 * Creates a memo row with stable render identity.
 *
 * @param row - The memo key and value.
 * @returns An editable memo row.
 */
function editableMemoRow(row: MemoRow): EditableMemoRow {
  return { ...row, id: crypto.randomUUID() };
}

/**
 * Removes render-only identifiers from editable memo rows.
 *
 * @param rows - Memo rows with stable render identifiers.
 * @returns Memo rows suitable for wizard state and API conversion.
 */
function toMemoRows(rows: EditableMemoRow[]): MemoRow[] {
  return rows.map((row) => ({ key: row.key, value: row.value }));
}

/**
 * Translates a memo validation error code into user-facing copy.
 *
 * @param t - Translator resolved from the i18n provider.
 * @param code - Validation error code from validateMemoRows.
 * @returns The localized error message.
 */
function memoErrorText(t: ReturnType<typeof useTranslations>, code: MemoRowErrorCode): string {
  switch (code) {
    case "keyRequired":
      return t("DashboardPayments.ramps.memoErrorKeyRequired");
    case "keyTooLong":
      return t("DashboardPayments.ramps.memoErrorKeyTooLong", {
        limit: RAMPS_MEMO_LIMITS.maxKeyLength,
      });
    case "keyDuplicate":
      return t("DashboardPayments.ramps.memoErrorKeyDuplicate");
    case "valueRequired":
      return t("DashboardPayments.ramps.memoErrorValueRequired");
    case "valueTooLong":
      return t("DashboardPayments.ramps.memoErrorValueTooLong", {
        limit: RAMPS_MEMO_LIMITS.maxValueLength,
      });
    case "tooManyFields":
      return t("DashboardPayments.ramps.memoErrorTooManyFields", {
        limit: RAMPS_MEMO_LIMITS.maxEntries,
      });
    default: {
      const exhaustive: never = code;
      throw new Error(`Unhandled memo error code: ${String(exhaustive)}`);
    }
  }
}

/**
 * Renders the inline optional ramp memo editor and JSON preview.
 *
 * @param props - Memo rows and the wizard-state change callback.
 * @returns The memo wizard step content.
 */
export function MemoStepContent({ rows, onChange }: MemoStepContentProps) {
  const t = useTranslations();
  const [editableRows, setEditableRows] = useState<EditableMemoRow[]>(() =>
    rows.length === 0 ? [editableMemoRow(emptyMemoRow())] : rows.map(editableMemoRow)
  );
  const memoRows = toMemoRows(editableRows);
  const errors = validateMemoRows(memoRows);
  const populatedRows = memoRows.filter((row) => !isEmptyMemoRow(row));

  const commitRows = (nextRows: EditableMemoRow[]) => {
    setEditableRows(nextRows);
    onChange(toMemoRows(nextRows));
  };

  const updateRow = (index: number, field: keyof MemoRow, value: string) => {
    commitRows(
      editableRows.map((row, rowIndex) => (rowIndex === index ? { ...row, [field]: value } : row))
    );
  };

  const removeRow = (index: number) => {
    const remaining = editableRows.filter((_, rowIndex) => rowIndex !== index);
    commitRows(remaining.length === 0 ? [editableMemoRow(emptyMemoRow())] : remaining);
  };

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const parsed = splitPastedMemoRows(event.clipboardData.getData("text"));
    if (parsed.length === 0) {
      return;
    }
    event.preventDefault();
    const retainedRows = editableRows.filter((row) => !isEmptyMemoRow(row));
    commitRows([...retainedRows, ...parsed.map(editableMemoRow)]);
  };

  return (
    <div className="space-y-5">
      <p className="text-sm text-tertiary">{t("DashboardPayments.ramps.memoDescription")}</p>

      <div className="flex items-center gap-2 px-1 text-xs font-medium text-tertiary">
        <span className="flex-1">{t("DashboardPayments.ramps.memoKey")}</span>
        <span className="flex-1">{t("DashboardPayments.ramps.memoValue")}</span>
        <span className="size-9" />
      </div>

      <div className="space-y-2">
        {editableRows.map((row, index) => {
          const rowErrors = errors.filter((error) => error.row === index + 1);
          return (
            <div key={row.id}>
              <div className="flex items-start gap-2">
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
                  className="flex h-[var(--input-height-xl)] w-9 shrink-0 items-center justify-center rounded-lg text-tertiary transition-colors hover:bg-fill-subtle hover:text-primary"
                >
                  <XIcon className="size-4" />
                </button>
              </div>
              {rowErrors.length > 0 ? (
                <div className="mt-1 space-y-1 text-xs text-error">
                  {rowErrors.map((error) => (
                    <p key={error.code}>{memoErrorText(t, error.code)}</p>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={() => commitRows([...editableRows, editableMemoRow(emptyMemoRow())])}
        disabled={editableRows.length >= RAMPS_MEMO_LIMITS.maxEntries}
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
              <p key={error.code}>{memoErrorText(t, error.code)}</p>
            ))}
        </div>
      ) : null}

      {populatedRows.length > 0 ? (
        <div className="space-y-3">
          <div className="space-y-1">
            <p className="text-base font-medium text-primary">
              {t("DashboardPayments.ramps.memoJsonTitle")}
            </p>
            <p className="text-sm text-tertiary">
              {t("DashboardPayments.ramps.memoJsonDescription")}
            </p>
          </div>
          <pre className="overflow-auto rounded-xl border border-border-default bg-surface-sunken p-4 font-mono text-sm text-primary">
            <code>{JSON.stringify(memoRowsToRecord(memoRows), null, 2)}</code>
          </pre>
        </div>
      ) : null}
    </div>
  );
}
