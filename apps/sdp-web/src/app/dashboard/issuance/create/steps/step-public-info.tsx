"use client";

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
      <PublicInfoPreview
        draft={draft}
        onToggleField={(path, enabled) =>
          updateDraft({ publicFields: togglePublicField(draft.publicFields, path, enabled) })
        }
      />
    </motion.div>
  );
}
