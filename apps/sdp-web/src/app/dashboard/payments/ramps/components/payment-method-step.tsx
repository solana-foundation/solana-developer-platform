"use client";

import { ArrowLeftRight, Banknote } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type PaymentMethod = "onchain" | "ramp";

interface PaymentMethodStepProps {
  mode: "send" | "receive";
  value: PaymentMethod | null;
  onChange: (method: PaymentMethod) => void;
}

type MethodOption = {
  id: PaymentMethod;
  title: string;
  description: string;
  icon: ReactNode;
};

function buildOptions(mode: "send" | "receive"): MethodOption[] {
  if (mode === "send") {
    return [
      {
        id: "onchain",
        title: "Onchain transfer",
        description: "Send crypto from an SDP wallet to a counterparty's Solana address.",
        icon: <ArrowLeftRight className="size-5" />,
      },
      {
        id: "ramp",
        title: "Off-ramp to fiat",
        description: "Convert crypto to fiat and pay out through a provider.",
        icon: <Banknote className="size-5" />,
      },
    ];
  }
  return [
    {
      id: "onchain",
      title: "Onchain deposit",
      description: "Receive crypto directly to an SDP wallet address.",
      icon: <ArrowLeftRight className="size-5" />,
    },
    {
      id: "ramp",
      title: "On-ramp from fiat",
      description: "Buy crypto with fiat through a provider and deposit it into a wallet.",
      icon: <Banknote className="size-5" />,
    },
  ];
}

export function PaymentMethodStep({ mode, value, onChange }: PaymentMethodStepProps) {
  return (
    <div className="space-y-3">
      {buildOptions(mode).map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() => onChange(option.id)}
          className={cn(
            "flex w-full items-center gap-3 rounded-2xl bg-border-extra-light px-4 py-4 text-left outline outline-2 -outline-offset-2 transition-colors focus-visible:ring-2 focus-visible:ring-black/50 dark:focus-visible:ring-white/50",
            value === option.id
              ? "outline-border-medium ring-2 ring-text-low ring-offset-2 ring-offset-white"
              : "outline-transparent hover:bg-border-light"
          )}
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-white text-text-extra-high">
            {option.icon}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-base font-medium text-text-extra-high">{option.title}</span>
            <span className="block text-sm text-text-low">{option.description}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
