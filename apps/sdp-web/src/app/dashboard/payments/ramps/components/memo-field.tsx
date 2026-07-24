"use client";

import { useState } from "react";
import { useTranslations } from "@/i18n/provider";
import { MemoDialog } from "./memo-dialog";

interface MemoFieldProps {
  memo: Record<string, string>;
  onChange: (memo: Record<string, string>) => void;
}

/**
 * Renders the ramp memo trigger and its memo editing dialog.
 *
 * @param props - Memo value and change callback.
 * @returns The memo trigger row and modal.
 */
export function MemoField({ memo, onChange }: MemoFieldProps) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const fieldCount = Object.keys(memo).length;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-between rounded-xl border border-border-default bg-[var(--input-bg-idle)] px-4 py-3 text-left text-sm transition-colors hover:bg-[var(--input-bg-hover)]"
      >
        <span className="font-medium text-primary">
          {fieldCount === 0
            ? t("DashboardPayments.ramps.addMemo")
            : t("DashboardPayments.ramps.memoFieldCount", { count: fieldCount })}
        </span>
        <span className="text-tertiary">{t("DashboardPayments.ramps.memoOptional")}</span>
      </button>
      {open ? (
        <MemoDialog open={open} memo={memo} onClose={() => setOpen(false)} onSave={onChange} />
      ) : null}
    </>
  );
}
