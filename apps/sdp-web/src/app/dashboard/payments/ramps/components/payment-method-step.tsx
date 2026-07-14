"use client";

import { ArrowLeftRight, Banknote } from "lucide-react";
import type { ReactNode } from "react";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
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

type Translate = (key: MessageKey, values?: TranslationValues) => string;

function buildOptions(t: Translate, mode: "send" | "receive"): MethodOption[] {
  if (mode === "send") {
    return [
      {
        id: "onchain",
        title: t("DashboardPayments.paymentMethods.onchainTransfer"),
        description: t("DashboardPayments.paymentMethods.onchainTransferDescription"),
        icon: <ArrowLeftRight className="size-5" />,
      },
      {
        id: "ramp",
        title: t("DashboardPayments.paymentMethods.payWithFiat"),
        description: t("DashboardPayments.paymentMethods.payWithFiatDescription"),
        icon: <Banknote className="size-5" />,
      },
    ];
  }
  return [
    {
      id: "onchain",
      title: t("DashboardPayments.paymentMethods.onchainDeposit"),
      description: t("DashboardPayments.paymentMethods.onchainDepositDescription"),
      icon: <ArrowLeftRight className="size-5" />,
    },
    {
      id: "ramp",
      title: t("DashboardPayments.paymentMethods.depositWithFiat"),
      description: t("DashboardPayments.paymentMethods.depositWithFiatDescription"),
      icon: <Banknote className="size-5" />,
    },
  ];
}

export function PaymentMethodStep({ mode, value, onChange }: PaymentMethodStepProps) {
  const t = useTranslations();
  return (
    <div className="space-y-3">
      {buildOptions(t, mode).map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() => onChange(option.id)}
          className={cn(
            "flex w-full items-center gap-3 rounded-2xl bg-fill-subtle px-4 py-4 text-left outline outline-2 -outline-offset-2 transition-colors focus-visible:ring-2 focus-visible:ring-black/50 dark:focus-visible:ring-white/50",
            value === option.id
              ? "outline-border-strong ring-2 ring-tertiary ring-offset-2 ring-offset-white"
              : "outline-transparent hover:bg-fill-strong"
          )}
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-white text-primary">
            {option.icon}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-base font-medium text-primary">{option.title}</span>
            <span className="block text-sm text-tertiary">{option.description}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
