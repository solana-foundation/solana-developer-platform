"use client";

import { useState } from "react";
import { useTranslations } from "@/i18n/provider";
import { MetadataDialog } from "./metadata-dialog";

interface MetadataFieldProps {
  metadata: Record<string, string>;
  onChange: (metadata: Record<string, string>) => void;
}

/**
 * Renders the ramp memo trigger and its metadata editing dialog.
 *
 * @param props - Metadata value and change callback.
 * @returns The memo trigger row and modal.
 */
export function MetadataField({ metadata, onChange }: MetadataFieldProps) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const fieldCount = Object.keys(metadata).length;

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
        <MetadataDialog
          open={open}
          metadata={metadata}
          onClose={() => setOpen(false)}
          onSave={onChange}
        />
      ) : null}
    </>
  );
}
