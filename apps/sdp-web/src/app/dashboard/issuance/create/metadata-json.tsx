"use client";

import type { IssuanceMetadata } from "@sdp/types";
import { Code2 } from "lucide-react";

// "View JSON" affordance for the Asset details step. Split into a header toggle
// and a full-width panel so a large body / long line wraps and scrolls inside
// its own box instead of stretching the page layout.

export function MetadataJsonToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[rgba(28,28,29,0.12)] px-3 py-1.5 text-sm font-medium text-[rgba(28,28,29,0.7)] transition-colors hover:bg-[rgba(28,28,29,0.04)] hover:text-[#1c1c1d]"
    >
      <Code2 className="h-4 w-4" />
      {open ? "Hide JSON" : "View JSON"}
    </button>
  );
}

// A code surface, so monospace is allowed here. `whitespace-pre-wrap` keeps the
// indentation while wrapping long lines; `break-words` handles unbreakable
// tokens (URLs); `overflow-auto` + `max-h-80` bound a large body.
export function MetadataJsonPanel({ metadata }: { metadata: IssuanceMetadata }) {
  return (
    <pre className="max-h-80 w-full min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-[rgba(28,28,29,0.1)] bg-[rgba(28,28,29,0.03)] p-4 text-left font-mono text-xs leading-relaxed text-[#1c1c1d]">
      {JSON.stringify(metadata, null, 2)}
    </pre>
  );
}
