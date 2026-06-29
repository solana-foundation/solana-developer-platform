"use client";

import {
  Loader2Icon,
  type LucideIcon,
  MinusCircleIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { HeightReveal } from "@/components/ui/height-reveal";
import { COMPLIANCE_PROVIDER_LOGOS, type ComplianceProviderResult } from "@/lib/compliance";
import {
  formatRiskScore,
  type RiskTone,
  resolveRiskTone,
  toProviderLabel,
} from "../payments-workspace.data";

const ROW_HOLD_MS = 650;
const ROW_STAGGER_MS = 420;
const COMPLETE_DELAY_MS = 500;

const TONE_ICON = {
  green: { Icon: ShieldCheckIcon, className: "text-[#115e3d]" },
  yellow: { Icon: TriangleAlertIcon, className: "text-[#8a5a00]" },
  red: { Icon: ShieldAlertIcon, className: "text-[#9e2b38]" },
  neutral: { Icon: MinusCircleIcon, className: "text-text-medium" },
} as const satisfies Record<RiskTone, { Icon: LucideIcon; className: string }>;

interface ScreeningProgressProps {
  results: ComplianceProviderResult[];
  onComplete: () => void;
}

export function ScreeningProgress({ results, onComplete }: ScreeningProgressProps) {
  const [resolvedCount, setResolvedCount] = useState(0);
  const firedRef = useRef(false);

  useEffect(() => {
    const timers = results.map((_, index) =>
      setTimeout(
        () => setResolvedCount((count) => Math.max(count, index + 1)),
        ROW_HOLD_MS + index * ROW_STAGGER_MS
      )
    );
    return () => timers.forEach(clearTimeout);
  }, [results]);

  useEffect(() => {
    if (!firedRef.current && results.length > 0 && resolvedCount >= results.length) {
      firedRef.current = true;
      const timer = setTimeout(onComplete, COMPLETE_DELAY_MS);
      return () => clearTimeout(timer);
    }
  }, [resolvedCount, results.length, onComplete]);

  return (
    <HeightReveal>
      <div className="space-y-2">
        <div className="text-sm font-medium text-text-medium">Compliance screening</div>
        <ul className="space-y-1.5">
          {results.map((result, index) => (
            <ScreeningRow
              key={result.provider}
              result={result}
              index={index}
              resolved={index < resolvedCount}
            />
          ))}
        </ul>
      </div>
    </HeightReveal>
  );
}

interface ScreeningRowProps {
  result: ComplianceProviderResult;
  index: number;
  resolved: boolean;
}

function ScreeningRow({ result, index, resolved }: ScreeningRowProps) {
  const { Icon, className } = TONE_ICON[resolveRiskTone(result)];
  const logo = COMPLIANCE_PROVIDER_LOGOS[result.provider];

  return (
    <motion.li
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.1 }}
      className="flex items-center justify-between gap-3 rounded-xl bg-[rgba(255,255,255,0.6)] px-3 py-2 text-sm"
    >
      <span className="flex items-center gap-2 font-medium text-text-high">
        {logo ? (
          <Image
            src={logo}
            alt=""
            width={16}
            height={16}
            className="size-4 shrink-0 opacity-70 grayscale"
          />
        ) : null}
        {toProviderLabel(result.provider)}
      </span>
      <div className="flex items-center gap-2">
        <AnimatePresence mode="wait" initial={false}>
          {resolved ? (
            <motion.span
              key="score"
              initial={{ opacity: 0, x: 4 }}
              animate={{ opacity: 1, x: 0 }}
              className="text-xs text-text-medium"
            >
              {formatRiskScore(result)}
            </motion.span>
          ) : (
            <motion.span
              key="checking"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="text-xs text-text-extra-low"
            >
              Checking…
            </motion.span>
          )}
        </AnimatePresence>
        <AnimatePresence mode="wait" initial={false}>
          {resolved ? (
            <motion.span
              key="icon"
              initial={{ scale: 0.3, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 500, damping: 20 }}
              className={className}
            >
              <Icon className="size-4" />
            </motion.span>
          ) : (
            <motion.span key="spinner" exit={{ opacity: 0 }} className="text-text-low">
              <Loader2Icon className="size-4 animate-spin" />
            </motion.span>
          )}
        </AnimatePresence>
      </div>
    </motion.li>
  );
}
