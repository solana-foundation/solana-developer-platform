"use client";

import { Trash2Icon } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { RecordBlock } from "@/components/refresh-record";
import { Button } from "@/components/ui/button";
import { StatusText } from "@/components/ui/status-text";
import { useLocale, useTranslations } from "@/i18n/provider";
import {
  type LocalDraft,
  removeLocalDraft,
  saveLocalDraft,
  useLocalDrafts,
} from "./create/local-drafts.redesign";
import { formatTokenDay } from "./issuance-token-state.redesign";
import { IssuedTokenMark } from "./issued-token-mark.redesign";

const CREATE_PATH = "/dashboard/issuance/create";
const DRAFT_STEPS = 5;

/**
 * Drafts left unfinished in this browser, above the project's tokens: SDP stores a draft only
 * once it is complete, so until then it lives here and opens back in the draft flow. Renders
 * nothing when there are none.
 */
export function LocalDraftsBlock() {
  const t = useTranslations();
  const { storageKey, drafts } = useLocalDrafts();
  if (!storageKey || drafts.length === 0) return null;

  return (
    <RecordBlock
      title={t("DashboardIssuance.newDesign.localDrafts.title")}
      aside={
        <span className="text-meta text-tertiary">
          {t("DashboardIssuance.newDesign.localDrafts.note")}
        </span>
      }
    >
      <ul className="flex flex-col">
        {drafts.map((entry) => (
          <li key={entry.id}>
            <LocalDraftRow
              entry={entry}
              onDiscard={() => {
                removeLocalDraft(storageKey, entry.id);
                toast(t("DashboardIssuance.newDesign.localDrafts.discarded"), {
                  position: "bottom-right",
                  action: {
                    label: t("DashboardIssuance.newDesign.localDrafts.undo"),
                    onClick: () => saveLocalDraft(storageKey, entry),
                  },
                });
              }}
            />
          </li>
        ))}
      </ul>
    </RecordBlock>
  );
}

function LocalDraftRow({ entry, onDiscard }: { entry: LocalDraft; onDiscard: () => void }) {
  const t = useTranslations();
  const locale = useLocale();
  const name = entry.draft.name.trim() || t("DashboardIssuance.newDesign.localDrafts.untitled");
  const symbol = entry.draft.symbol.trim();

  return (
    <div className="-mx-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 rounded-control border-b border-border-subtle hover:bg-fill-subtle">
      <Link
        href={`${CREATE_PATH}?draft=${encodeURIComponent(entry.id)}`}
        data-issuance-local-draft={entry.id}
        className="grid grid-cols-[36px_minmax(0,1fr)_max-content] items-center gap-x-3 rounded-control px-2 py-4 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
      >
        <IssuedTokenMark symbol={symbol || name} name={name} logoUrl={null} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className="truncate text-body font-medium text-primary">{name}</span>
            {symbol ? (
              <span className="text-meta tracking-wide text-tertiary uppercase">{symbol}</span>
            ) : null}
          </span>
          <StatusText tone="neutral" className="text-meta">
            {t("DashboardIssuance.newDesign.localDrafts.state", {
              current: Math.min(entry.step + 1, DRAFT_STEPS),
              total: DRAFT_STEPS,
            })}
          </StatusText>
        </span>
        <span className="flex flex-col items-end gap-1 text-right">
          <span className="text-meta text-tertiary">
            {t("DashboardIssuance.newDesign.localDrafts.saved")}
          </span>
          <span className="text-body text-primary tabular-nums">
            {formatTokenDay(entry.savedAt, locale) ?? "—"}
          </span>
        </span>
      </Link>
      <Button
        variant="ghost"
        size="icon-sm"
        className="mr-2"
        aria-label={t("DashboardIssuance.newDesign.localDrafts.discard", { name })}
        onClick={onDiscard}
      >
        <Trash2Icon aria-hidden="true" />
      </Button>
    </div>
  );
}
