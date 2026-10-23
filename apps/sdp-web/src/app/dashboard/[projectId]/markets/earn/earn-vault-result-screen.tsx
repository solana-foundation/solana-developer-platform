"use client";

import { Badge, type BadgeVariant } from "@sdp/ui/badge";
import { Button } from "@sdp/ui/button";
import type { ReactNode } from "react";
import { useTranslations } from "@/i18n/provider";
import { EarnOutcomeMark } from "./earn-outcome-mark";
import { vaultOutcomeTone } from "./earn-vault-ui-state";

/**
 * Shared outcome screen for the finished step of the vault deposit and
 * withdrawal modals: the mark, headline with status badge, body, summary rows
 * and the Done button. Callers keep their own copy state machines and decide
 * their own summary rows; this only holds the identical markup so the two
 * screens cannot drift.
 */
export function VaultResultScreen({
  copy,
  status,
  statusVariant,
  processing,
  onClose,
  rows,
}: {
  /** Headline, body and footnote copy for this outcome. */
  copy: { title: string; body: string; note: string };
  /** Resolved status label, preferring the position-status label over the copy's own. */
  status: string;
  statusVariant: BadgeVariant;
  /** While the movement is still processing the mark is withheld. */
  processing: boolean;
  onClose: () => void;
  rows: ReactNode;
}) {
  const t = useTranslations();

  return (
    <>
      {processing ? null : <EarnOutcomeMark tone={vaultOutcomeTone(statusVariant)} />}
      <div className="flex items-center gap-2 pr-8">
        <h2
          className="text-base font-medium text-primary outline-none"
          data-modal-focus-target
          tabIndex={-1}
        >
          {copy.title}
        </h2>
        <Badge variant={statusVariant}>{status}</Badge>
      </div>
      <p className="mt-2 text-sm leading-5 text-secondary">{copy.body}</p>

      <dl className="mt-5 grid gap-3 rounded-xl bg-fill-subtle px-4 py-3 text-sm">{rows}</dl>
      <p className="mt-4 text-xs leading-5 text-tertiary">{copy.note}</p>
      <div className="mt-5 flex justify-end">
        <Button onClick={onClose}>{t("DashboardEarn.withdraw.done")}</Button>
      </div>
    </>
  );
}
