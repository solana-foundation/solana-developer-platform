"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";

interface HeightRevealProps {
  children: ReactNode;
  durationSeconds?: number;
}

export function HeightReveal({ children, durationSeconds = 0.3 }: HeightRevealProps) {
  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: durationSeconds, ease: "easeOut" }}
      style={{ overflow: "hidden" }}
    >
      {children}
    </motion.div>
  );
}
