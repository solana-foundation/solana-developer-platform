"use client";

import type { IssuanceMetadata } from "@sdp/types";
import { Check, Code2, Copy } from "lucide-react";
import { useTranslations } from "@/i18n/provider";
import { useCopy } from "@/lib/use-copy";

// "View JSON" affordance for the Asset details step. Split into a header toggle
// and a full-width panel so a large body / long line wraps and scrolls inside
// its own box instead of stretching the page layout.

export function MetadataJsonToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const t = useTranslations();
  return (
    <button
      type="button"
      onClick={onToggle}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border-default px-3 py-1.5 text-sm font-medium text-secondary transition-colors hover:bg-fill-subtle hover:text-primary"
    >
      <Code2 className="h-4 w-4" />
      {open
        ? t("DashboardIssuance.assetDetails.hideJson")
        : t("DashboardIssuance.assetDetails.viewJson")}
    </button>
  );
}

// A copyable JSON code surface. Monospace is allowed here (a code surface).
// `whitespace-pre-wrap` keeps indentation while wrapping long lines; `break-words`
// handles unbreakable tokens (URLs); `overflow-auto` + `max-h-80` bound a large body.
export function JsonCodeBlock({ value }: { value: unknown }) {
  const t = useTranslations();
  const jsonString = JSON.stringify(value, null, 2);
  const { copied, copy } = useCopy(1200);

  return (
    <div className="relative rounded-xl border border-border-default bg-fill-subtle">
      <button
        type="button"
        onClick={() => void copy(jsonString)}
        className="absolute right-3 top-3 inline-flex items-center justify-center rounded-lg p-1.5 text-tertiary transition-all hover:bg-fill-strong hover:text-primary"
        title={
          copied
            ? t("DashboardIssuance.assetDetails.copied")
            : t("DashboardIssuance.assetDetails.copyJson")
        }
      >
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      </button>
      <pre className="max-h-80 w-full min-w-0 overflow-auto whitespace-pre-wrap break-words p-4 text-left font-mono text-xs leading-relaxed text-primary">
        {jsonString}
      </pre>
    </div>
  );
}

// The Asset details step's public-metadata JSON view (what the token publishes).
// The on-chain deploy payload lives in the Advanced settings editor's technical
// mode, next to the controls that produce it — deliberately not duplicated here.
export function MetadataJsonPanel({ metadata }: { metadata: IssuanceMetadata }) {
  return <JsonCodeBlock value={metadata} />;
}
