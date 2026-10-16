"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";

interface SectionEntryProps {
  children: ReactNode;
  delay?: number;
}

export function SectionEntry({ children, delay = 0 }: SectionEntryProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut", delay }}
    >
      {children}
    </motion.div>
  );
}
