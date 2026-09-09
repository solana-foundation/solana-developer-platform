"use client";

import type { Counterparty, CounterpartyResponse, CreateCounterpartyRequest } from "@sdp/types";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "@/i18n/provider";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { useZodForm, type ZodFormApi } from "@/lib/use-zod-form";
import { defaultBasics } from "./counterparty-create-defaults";
import { type BasicsClean, type BasicsData, basicsSchema } from "./counterparty-create-schemas";

interface CounterpartyCreateContextValue {
  basics: ZodFormApi<BasicsData, BasicsClean>;

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

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [createdCounterparty, setCreatedCounterparty] = useState<Counterparty | null>(null);

  const submit = useCallback(async () => {
    const basicsResult = basics.validate();
    if (!basicsResult.ok) return;

    setSubmitError(null);
    setSubmitting(true);

    try {
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
  }, [basics, t]);

  const finish = useCallback(() => {
    if (onCreated && createdCounterparty) {
      onCreated(createdCounterparty);
      return;
    }

    router.refresh();
    router.push("/dashboard/payments/counterparty");
  }, [onCreated, createdCounterparty, router]);

  const value = useMemo(
    () => ({
      basics,
      submit,
      submitting,
      submitError,
      createdCounterparty,
      finish,
    }),
    [basics, submit, submitting, submitError, createdCounterparty, finish]
  );

  return (
    <CounterpartyCreateContext.Provider value={value}>
      {children}
    </CounterpartyCreateContext.Provider>
  );
}

export function useCounterpartyCreate() {
  const ctx = useContext(CounterpartyCreateContext);
  if (!ctx) throw new Error("useCounterpartyCreate must be used within CounterpartyCreateProvider");
  return ctx;
}
