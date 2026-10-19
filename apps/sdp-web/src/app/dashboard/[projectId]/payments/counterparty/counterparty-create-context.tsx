"use client";

import type {
  Counterparty,
  CounterpartyResponse,
  CreateCounterpartyRequest,
} from "@sdp/types/counterparties";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { toast } from "sonner";
import { paymentsQueryKeys } from "@/app/dashboard/[projectId]/payments/payments-query-key";
import { useTranslations } from "@/i18n/provider";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { fetchResultAnswer } from "@/lib/idempotency";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { useOutcomeUnknownNotice } from "@/lib/use-outcome-unknown";
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
  const href = useProjectHref();
  const t = useTranslations();
  const notice = useOutcomeUnknownNotice(paymentsQueryKeys.isCounterpartyListKey);

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
        if (notice(fetchResultAnswer(result))) return;
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
  }, [basics, notice, t]);

  const finish = useCallback(() => {
    if (onCreated && createdCounterparty) {
      onCreated(createdCounterparty);
      return;
    }

    router.refresh();
    router.push(href("/dashboard/payments/counterparty"));
  }, [onCreated, createdCounterparty, router, href]);

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
