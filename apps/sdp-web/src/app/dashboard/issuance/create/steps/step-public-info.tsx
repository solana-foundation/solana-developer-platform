"use client";

import { motion } from "motion/react";

export function StepPublicInfo() {
  return (
    <motion.div
      key="public-info"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      className="space-y-8"
    >
      <div>
        <h2 className="text-2xl font-medium text-[#1c1c1d]">Public information</h2>
        <p className="mt-1.5 text-sm text-[rgba(28,28,29,0.62)]">
          Review what will be made public through the token metadata URI.
        </p>
      </div>

      <div className="rounded-2xl border border-dashed border-[rgba(28,28,29,0.16)] bg-[rgba(28,28,29,0.02)] p-8 text-center">
        <p className="text-sm font-medium text-[#1c1c1d]">Coming next</p>
        <p className="mt-1 text-sm text-[rgba(28,28,29,0.58)]">
          This step will show a public preview, the included public fields, and the fields that stay
          private by default.
        </p>
      </div>
    </motion.div>
  );
}
