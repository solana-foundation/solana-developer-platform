"use client";

import { motion } from "motion/react";
import Image from "next/image";
import { RAMP_PROVIDER_LOGOS, type RampProviderOption } from "@/lib/ramps";
import { cn } from "@/lib/utils";

interface ProviderCardProps {
  option: RampProviderOption;
  active: boolean;
  onSelect: () => void;
}

export function ProviderCard({ option, active, onSelect }: ProviderCardProps) {
  return (
    <motion.button
      type="button"
      onClick={onSelect}
      layout
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{
        layout: { type: "spring", stiffness: 500, damping: 40, mass: 0.6 },
        opacity: { duration: 0.15 },
        scale: { duration: 0.15 },
      }}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl border bg-border-extra-light px-4 py-3 text-left transition-colors",
        active ? "border-border-medium" : "border-transparent hover:bg-border-light"
      )}
    >
      <Image
        src={RAMP_PROVIDER_LOGOS[option.id]}
        alt=""
        width={32}
        height={32}
        className="size-8 shrink-0 rounded-lg object-contain"
      />

      <p
        className={cn(
          "min-w-0 flex-1 text-lg leading-tight text-text-extra-high",
          active ? "font-medium" : "font-normal"
        )}
      >
        {option.title}
      </p>
    </motion.button>
  );
}
