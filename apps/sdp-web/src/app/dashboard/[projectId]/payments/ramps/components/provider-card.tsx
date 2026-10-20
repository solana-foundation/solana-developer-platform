"use client";
import type { RampProviderEstimateResult } from "@sdp/types/payments";
import { cn } from "@sdp/ui/cn";
import { motion } from "motion/react";
import Image from "next/image";
import { RAMP_PROVIDER_LOGOS, type RampProviderOption } from "@/lib/ramps";
import { ProviderCardEstimate } from "./provider-card-estimate";

interface ProviderCardProps {
  option: RampProviderOption;
  active: boolean;
  estimate?: RampProviderEstimateResult;
  estimateLoading?: boolean;
  onSelect: () => void;
}

export function ProviderCard({
  option,
  active,
  estimate,
  estimateLoading,
  onSelect,
}: ProviderCardProps) {
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
        "flex w-full items-center gap-3 rounded-xl bg-fill-subtle px-4 py-3 text-left outline outline-2 -outline-offset-2 transition-colors",
        active
          ? "outline-border-strong ring-2 ring-tertiary ring-offset-2 ring-offset-surface-raised"
          : "outline-transparent hover:bg-fill-strong"
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
          "min-w-0 flex-1 text-lg leading-tight text-primary",
          active ? "font-medium" : "font-normal"
        )}
      >
        {option.title}
      </p>

      <ProviderCardEstimate
        estimate={estimate}
        estimateLoading={estimateLoading}
        minimumFractionDigits={0}
      />
    </motion.button>
  );
}
