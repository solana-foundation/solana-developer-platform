"use client";

import { ExternalLink } from "lucide-react";
import { motion } from "motion/react";
import { togglePublicField } from "../draft-mapping";
import { PublicInfoPreview } from "../public-info-preview";
import { useIssuanceDraft } from "../use-issuance-draft";

export function StepPublicInfo() {
  const { draft, updateDraft } = useIssuanceDraft();

  return (
    <motion.div
      key="public-info"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="space-y-5"
    >
      <div>
        <h2 className="text-2xl font-medium text-[#1c1c1d]">Public information</h2>
        <p className="mt-1.5 text-sm text-[rgba(28,28,29,0.62)]">
          This is how your asset will appear to wallets, explorers, and the public.
        </p>
      </div>

      <PublicInfoPreview
        draft={draft}
        onToggleField={(path, enabled) =>
          updateDraft({ publicFields: togglePublicField(draft.publicFields, path, enabled) })
        }
      />

      <div className="flex items-start gap-2 rounded-2xl border border-[rgba(28,28,29,0.1)] bg-[rgba(28,28,29,0.02)] px-4 py-3">
        <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-[rgba(28,28,29,0.5)]" />
        <p className="text-sm text-[rgba(28,28,29,0.6)]">
          You can change what&apos;s public at any time from the Public information tab.
        </p>
      </div>
    </motion.div>
  );
}
