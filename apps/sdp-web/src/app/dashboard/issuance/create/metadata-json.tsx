"use client";

import type { IssuanceMetadata } from "@sdp/types";
import { Code2 } from "lucide-react";
import { useState } from "react";

interface MetadataJsonProps {
  metadata: IssuanceMetadata;
}

// "View JSON" toggle. A code/JSON surface, so monospace is allowed here.
export function MetadataJson({ metadata }: MetadataJsonProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="text-right">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-[rgba(28,28,29,0.7)] transition-colors hover:text-[#1c1c1d]"
      >
        {open ? "Hide JSON" : "View JSON"}
        <Code2 className="h-4 w-4" />
      </button>
      {open ? (
        <pre className="mt-3 max-h-80 overflow-auto rounded-xl border border-[rgba(28,28,29,0.1)] bg-[rgba(28,28,29,0.03)] p-4 text-left font-mono text-xs leading-relaxed text-[#1c1c1d]">
          {JSON.stringify(metadata, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}
