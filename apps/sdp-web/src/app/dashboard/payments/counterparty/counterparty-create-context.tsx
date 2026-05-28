"use client";

import type { CreateCounterpartyRequest } from "@sdp/types";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { createContext, useContext, useMemo, useState } from "react";
import { toast } from "sonner";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { useZodForm, type ZodFormApi } from "@/lib/use-zod-form";
import {
  defaultAddress,
  defaultBasics,
  defaultIdentity,
  getSteps,
} from "./counterparty-create-defaults";
import {
  type AddressClean,
  type AddressData,
  addressSchema,
  type BasicsClean,
  type BasicsData,
  basicsSchema,
  type IdentityClean,
  type IdentityData,
  identitySchema,
  type StepId,
} from "./counterparty-create-schemas";

interface CounterpartyCreateContextValue {
  basics: ZodFormApi<BasicsData, BasicsClean>;
  identity: ZodFormApi<IdentityData, IdentityClean>;
  address: ZodFormApi<AddressData, AddressClean>;

  step: number;
  steps: StepId[];
  currentStepId: StepId;
  direction: 1 | -1;

  goNext: () => void;
  goBack: () => void;

  submit: () => Promise<void>;
  submitting: boolean;
  submitError: string | null;
}

const CounterpartyCreateContext = createContext<CounterpartyCreateContextValue | null>(null);

export function CounterpartyCreateProvider({ children }: { children: ReactNode }) {
  const router = useRouter();

  const basics = useZodForm(basicsSchema, defaultBasics);
  const identity = useZodForm(identitySchema, defaultIdentity);
  const address = useZodForm(addressSchema, defaultAddress);

  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const steps = useMemo(() => getSteps(basics.values.entityType), [basics.values.entityType]);
  const currentStepId = steps[step] ?? "basics";

  function goNext() {
    const form =
      currentStepId === "basics"
        ? basics
        : currentStepId === "identity"
          ? identity
          : currentStepId === "address"
            ? address
            : null;
    if (form && !form.validate().ok) return;

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
      const identityResult = identity.validate();
      const addressResult = address.validate();

      if (!basicsResult.ok || !identityResult.ok || !addressResult.ok) {
        throw new Error("Invalid form state");
      }

      const identityPayload =
        basicsResult.data.entityType === "individual"
          ? { ...identityResult.data, address: addressResult.data }
          : { address: addressResult.data };

      const body: CreateCounterpartyRequest = {
        entityType: basicsResult.data.entityType,
        displayName: basicsResult.data.displayName,
        email: basicsResult.data.email,
        externalId: basicsResult.data.externalId,
        identity: identityPayload,
      };

      const result = await dashboardFetch("/api/dashboard/counterparty", { method: "POST", body });

      if (!result.ok) {
        setSubmitError(result.error);
        return;
      }

      toast.success("Counterparty created", { position: "bottom-right" });
      router.refresh();
      router.push("/dashboard/payments/counterparty");
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <CounterpartyCreateContext.Provider
      value={{
        basics,
        identity,
        address,
        step,
        steps,
        currentStepId,
        direction,
        goNext,
        goBack,
        submit,
        submitting,
        submitError,
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
