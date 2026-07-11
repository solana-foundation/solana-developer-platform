"use client";

import type { IssuanceMetadata } from "@sdp/types";
import { Check, Code2, Copy } from "lucide-react";

import { useCopy } from "@/lib/use-copy";
import { useTranslations } from "@/i18n/provider";

// "View JSON" affordance for the Asset details step. Split into a header toggle
// and a full-width panel so a large body / long line wraps and scrolls inside
// its own box instead of stretching the page layout.

export function MetadataJsonToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const t = useTranslations();
  return (
    <button
      type="button"
      onClick={onToggle}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[rgba(28,28,29,0.12)] px-3 py-1.5 text-sm font-medium text-[rgba(28,28,29,0.7)] transition-colors hover:bg-[rgba(28,28,29,0.04)] hover:text-[#1c1c1d]"
    >
      <Code2 className="h-4 w-4" />
      {open
        ? t("DashboardIssuance.assetDetails.hideJson")
        : t("DashboardIssuance.assetDetails.viewJson")}
    </button>
  );
}

// A code surface, so monospace is allowed here. `whitespace-pre-wrap` keeps the
// indentation while wrapping long lines; `break-words` handles unbreakable
// tokens (URLs); `overflow-auto` + `max-h-80` bound a large body.
export function MetadataJsonPanel({ metadata }: { metadata: IssuanceMetadata }) {
  const t = useTranslations();
  const jsonString = JSON.stringify(metadata, null, 2);
  const { copied, copy } = useCopy(1200);

  return (
    <div className="relative rounded-xl border border-[rgba(28,28,29,0.1)] bg-[rgba(28,28,29,0.03)]">
      <button
        type="button"
        onClick={() => void copy(jsonString)}
        className="absolute right-3 top-3 inline-flex items-center justify-center rounded-lg p-1.5 text-[rgba(28,28,29,0.5)] transition-all hover:bg-[rgba(28,28,29,0.1)] hover:text-[#1c1c1d]"
        title={copied ? t("DashboardIssuance.assetDetails.copied") : t("DashboardIssuance.assetDetails.copyJson")}
      >
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      </button>
      <pre className="max-h-80 w-full min-w-0 overflow-auto whitespace-pre-wrap break-words p-4 text-left font-mono text-xs leading-relaxed text-[#1c1c1d]">
        {jsonString}
      </pre>
    </div>
  );
}
