"use client";

import { motion } from "motion/react";

export function StepReview() {
  return (
    <motion.div
      key="review"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="space-y-8"
    >
      <div>
        <h2 className="text-2xl font-medium text-[#1c1c1d]">Review &amp; finish</h2>
        <p className="mt-1.5 text-sm text-[rgba(28,28,29,0.62)]">
          Confirm the details and create your draft.
        </p>
      </div>

      <div className="rounded-2xl border border-dashed border-[rgba(28,28,29,0.16)] bg-[rgba(28,28,29,0.02)] p-8 text-center">
        <p className="text-sm font-medium text-[#1c1c1d]">Coming next</p>
        <p className="mt-1 text-sm text-[rgba(28,28,29,0.58)]">
          This step will confirm the summary, surface any blockers or warnings, and create the draft
          asset profile.
        </p>
      </div>
    </motion.div>
  );
}
