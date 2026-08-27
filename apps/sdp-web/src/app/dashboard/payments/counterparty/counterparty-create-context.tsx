"use client";

import type { Counterparty, CounterpartyResponse, CreateCounterpartyRequest } from "@sdp/types";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { createContext, useContext, useMemo, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "@/i18n/provider";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { useZodForm, type ZodFormApi } from "@/lib/use-zod-form";
import { COUNTERPARTY_CREATE_STEPS, defaultBasics } from "./counterparty-create-defaults";
import {
  type BasicsClean,
  type BasicsData,
  basicsSchema,
  type StepId,
} from "./counterparty-create-schemas";

interface CounterpartyCreateContextValue {
  basics: ZodFormApi<BasicsData, BasicsClean>;

  step: number;
  steps: readonly StepId[];
  currentStepId: StepId;
  direction: 1 | -1;

  goNext: () => void;
  goBack: () => void;

  submit: () => Promise<void>;
  submitting: boolean;
  submitError: string | null;

  createdCounterparty: Counterparty | null;
  finish: () => void;
}

const CounterpartyCreateContext = createContext<CounterpartyCreateContextValue | null>(null);

interface CounterpartyCreateProviderProps {
  children: ReactNode;
  onCreated?: (counterparty: Counterparty) => void;
}

export function CounterpartyCreateProvider({
  children,
  onCreated,
}: CounterpartyCreateProviderProps) {
  const router = useRouter();
  const t = useTranslations();

  const resolveValidationMessage = useMemo(
    () => () => t("DashboardPayments.counterparty.validation.required"),
    [t]
  );
  const basics = useZodForm(basicsSchema, defaultBasics, resolveValidationMessage);

  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [createdCounterparty, setCreatedCounterparty] = useState<Counterparty | null>(null);

  const steps = COUNTERPARTY_CREATE_STEPS;
  const currentStepId: StepId = step === 0 ? "basics" : "review";

  function validateCurrentStep(): boolean {
    switch (currentStepId) {
      case "basics":
        return basics.validate().ok;
      case "review":
        return true;
    }
  }

  function goNext() {
    if (!validateCurrentStep()) return;

    setDirection(1);
    setStep((s) => s + 1);
  }

  function goBack() {
    setDirection(-1);
    setStep((s) => Math.max(s - 1, 0));
  }

  async function submit() {
    setSubmitError(null);
    setSubmitting(true);

    try {
      const basicsResult = basics.validate();

      if (!basicsResult.ok) {
        throw new Error("Invalid form state");
      }

      const body: CreateCounterpartyRequest = {
        entityType: basicsResult.data.entityType,
        displayName: basicsResult.data.displayName,
        externalId: basicsResult.data.externalId,
      };

      const result = await dashboardFetch<{ data: CounterpartyResponse }>(
        "/api/dashboard/counterparty",
        { method: "POST", body }
      );

      if (!result.ok) {
        setSubmitError(result.error);
        return;
      }

      const created = result.data.data.counterparty;

      toast.success(t("DashboardPayments.counterparty.createdSuccess"), {
        position: "bottom-right",
      });
      setCreatedCounterparty(created);
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : t("DashboardPayments.counterparty.somethingWentWrong")
      );
    } finally {
      setSubmitting(false);
    }
  }

  function finish() {
    if (onCreated && createdCounterparty) {
      onCreated(createdCounterparty);
      return;
    }

    router.refresh();
    router.push("/dashboard/payments/counterparty");
  }

  return (
    <CounterpartyCreateContext.Provider
      value={{
        basics,
        step,
        steps,
        currentStepId,
        direction,
        goNext,
        goBack,
        submit,
        submitting,
        submitError,
        createdCounterparty,
        finish,
      }}
    >
      {children}
    </CounterpartyCreateContext.Provider>
  );
}

export function useCounterpartyCreate() {
  const ctx = useContext(CounterpartyCreateContext);
  if (!ctx) throw new Error("useCounterpartyCreate must be used within CounterpartyCreateProvider");
  return ctx;
}
