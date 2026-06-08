"use client";

import type {
  Counterparty,
  CounterpartyCompliance,
  CounterpartyResponse,
  CreateCounterpartyRequest,
} from "@sdp/types";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { createContext, useContext, useMemo, useState } from "react";
import { toast } from "sonner";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { useZodForm, type ZodFormApi } from "@/lib/use-zod-form";
import {
  defaultAddress,
  defaultBasics,
  defaultCompliance,
  defaultIdentity,
  getSteps,
  requiresCompliance,
} from "./counterparty-create-defaults";
import {
  type AddressClean,
  type AddressData,
  addressSchema,
  type BasicsClean,
  type BasicsData,
  basicsSchema,
  type ComplianceClean,
  type ComplianceData,
  complianceSchema,
  type IdentityClean,
  type IdentityData,
  identitySchema,
  type StepId,
} from "./counterparty-create-schemas";

interface CounterpartyCreateContextValue {
  basics: ZodFormApi<BasicsData, BasicsClean>;
  identity: ZodFormApi<IdentityData, IdentityClean>;
  address: ZodFormApi<AddressData, AddressClean>;
  compliance: ZodFormApi<ComplianceData, ComplianceClean>;

  step: number;
  steps: StepId[];
  currentStepId: StepId;
  direction: 1 | -1;

  goNext: () => void;
  goBack: () => void;

  submit: () => Promise<void>;
  submitting: boolean;
  submitError: string | null;

  // After a successful create we move to an optional "attach accounts" phase
  // for the freshly created counterparty.
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

  const basics = useZodForm(basicsSchema, defaultBasics);
  const identity = useZodForm(identitySchema, defaultIdentity);
  const address = useZodForm(addressSchema, defaultAddress);
  const compliance = useZodForm(complianceSchema, defaultCompliance);

  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [createdCounterparty, setCreatedCounterparty] = useState<Counterparty | null>(null);

  const steps = useMemo(
    () => getSteps(basics.values.entityType, address.values.countryCode),
    [basics.values.entityType, address.values.countryCode]
  );
  const currentStepId = steps[step] ?? "basics";

  function goNext() {
    const form =
      currentStepId === "basics"
        ? basics
        : currentStepId === "identity"
          ? identity
          : currentStepId === "address"
            ? address
            : currentStepId === "compliance"
              ? compliance
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

      const needsCompliance = requiresCompliance(
        basicsResult.data.entityType,
        addressResult.data.countryCode
      );

      let compliancePayload: CounterpartyCompliance | undefined;
      if (needsCompliance) {
        const complianceResult = compliance.validate();
        if (!complianceResult.ok) {
          throw new Error("Invalid form state");
        }
        const c = complianceResult.data;
        compliancePayload = {
          taxIdentification: { number: c.taxIdNumber, residenceCountryCode: "US" },
          nationality: c.nationality,
          birthCountryCode: c.birthCountryCode,
          cdd: {
            employmentStatus: c.employmentStatus,
            sourceOfFunds: c.sourceOfFunds,
            pepStatus: c.pepStatus,
            intendedUseOfAccount: c.intendedUseOfAccount,
            expectedMonthlyVolume: { amount: c.expectedMonthlyVolume, currency: "USD" },
            estimatedYearlyIncome: c.estimatedYearlyIncome,
            employmentIndustrySector: c.employmentIndustrySector,
          },
        };
      }

      const identityPayload =
        basicsResult.data.entityType === "individual"
          ? {
              ...identityResult.data,
              address: addressResult.data,
              ...(compliancePayload ? { compliance: compliancePayload } : {}),
            }
          : { address: addressResult.data };

      const body: CreateCounterpartyRequest = {
        entityType: basicsResult.data.entityType,
        displayName: basicsResult.data.displayName,
        email: basicsResult.data.email,
        externalId: basicsResult.data.externalId,
        identity: identityPayload,
      };

      const result = await dashboardFetch<{ data: CounterpartyResponse }>(
        "/api/dashboard/counterparty",
        { method: "POST", body }
      );

      if (!result.ok) {
        setSubmitError(result.error);
        return;
      }

      const created = result.data?.data?.counterparty ?? null;
      if (!created) {
        setSubmitError("Counterparty was created but could not be loaded.");
        return;
      }

      toast.success("Counterparty created", { position: "bottom-right" });
      setCreatedCounterparty(created);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Something went wrong");
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
        identity,
        address,
        compliance,
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
