"use client";

import type {
  Counterparty,
  CounterpartyAccountResponse,
  CounterpartyResponse,
  CreateCounterpartyRequest,
} from "@sdp/types";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "@/i18n/provider";
import { ComplianceNotEnabledError } from "@/lib/compliance";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { useZodForm, type ZodFormApi } from "@/lib/use-zod-form";
import { getHighRiskProviders, runComplianceCheck } from "../payments-workspace.data";
import { defaultBasics } from "./counterparty-create-defaults.redesign";
import {
  type BasicsClean,
  type BasicsData,
  basicsSchema,
} from "./counterparty-create-schemas.redesign";

/**
 * An address waiting on the person's call: one the screening flagged or could not screen
 * (`flagged`: add it anyway?), or one whose save failed after the contact was created
 * (`failed`: try again?).
 */
export interface FlaggedAddress {
  counterparty: Counterparty;
  address: string;
  message: string;
  reason: "flagged" | "failed";
}

interface CounterpartyCreateContextValue {
  basics: ZodFormApi<BasicsData, BasicsClean>;

  /** Creates the contact, then screens and attaches its address, then hands the contact on. */
  submit: () => Promise<void>;
  submitting: boolean;
  submitError: string | null;

  /** Set while the form waits on "Add anyway" / "Try again" or "Skip the address". */
  flaggedAddress: FlaggedAddress | null;
  attachFlaggedAddress: () => Promise<void>;
  skipFlaggedAddress: () => void;
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

  const resolveValidationMessage = useMemo(
    () => (message: string) =>
      t(
        message === "invalidAddress"
          ? "DashboardPayments.counterparty.validation.invalidAddress"
          : "DashboardPayments.counterparty.validation.required"
      ),
    [t]
  );
  const basics = useZodForm(basicsSchema, defaultBasics, resolveValidationMessage);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [flaggedAddress, setFlaggedAddress] = useState<FlaggedAddress | null>(null);

  // Where the contact goes once it exists: the caller's hand-off (a dialog inside a flow), or
  // the directory.
  const complete = useCallback(
    (created: Counterparty) => {
      if (onCreated) {
        onCreated(created);
        return;
      }
      router.refresh();
      router.push(href("/dashboard/payments/counterparty"));
    },
    [onCreated, router, href]
  );

  // Saves the address on the contact just created. A failure keeps the form open on it (the
  // contact exists, so submitting again would make a second one): the person can try again or
  // go on without the address. Returns whether it was saved.
  const attachAddress = useCallback(
    async (created: Counterparty, address: string): Promise<boolean> => {
      const result = await dashboardFetch<{ data: CounterpartyAccountResponse }>(
        `/api/dashboard/counterparty/${encodeURIComponent(created.id)}/accounts`,
        {
          method: "POST",
          body: { accountKind: "crypto_wallet", details: { network: "solana", address } },
        }
      );
      if (result.ok) return true;
      setFlaggedAddress({
        counterparty: created,
        address,
        reason: "failed",
        message: t("DashboardPayments.counterparty.addressNotAttached", {
          name: created.displayName,
          error: result.error,
        }),
      });
      return false;
    },
    [t]
  );

  /** Null when the address screens clean; otherwise why it needs the person's call. */
  const screen = useCallback(
    async (address: string): Promise<string | null> => {
      try {
        const result = await runComplianceCheck(address, "wallet_address_addition");
        if (result.providers.length === 0) {
          return t("DashboardPayments.counterparty.screeningUnavailable");
        }
        const flagged =
          getHighRiskProviders(result).length > 0 ||
          result.providers.some((provider) => provider.status !== "ok");
        return flagged ? t("DashboardPayments.counterparty.screeningWarning") : null;
      } catch (error) {
        return t(
          error instanceof ComplianceNotEnabledError
            ? "DashboardPayments.workspace.complianceNotEnabled"
            : "DashboardPayments.counterparty.screeningUnavailable"
        );
      }
    },
    [t]
  );

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

      const address = basicsResult.data.walletAddress;
      if (address === undefined) {
        complete(created);
        return;
      }
      const warning = await screen(address);
      if (warning !== null) {
        setFlaggedAddress({ counterparty: created, address, message: warning, reason: "flagged" });
        return;
      }
      if (await attachAddress(created, address)) complete(created);
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : t("DashboardPayments.counterparty.somethingWentWrong")
      );
    } finally {
      setSubmitting(false);
    }
  }, [basics, t, complete, screen, attachAddress]);

  const attachFlaggedAddress = useCallback(async () => {
    if (!flaggedAddress) return;
    setSubmitting(true);
    try {
      if (await attachAddress(flaggedAddress.counterparty, flaggedAddress.address)) {
        setFlaggedAddress(null);
        complete(flaggedAddress.counterparty);
      }
    } finally {
      setSubmitting(false);
    }
  }, [flaggedAddress, attachAddress, complete]);

  const skipFlaggedAddress = useCallback(() => {
    if (!flaggedAddress) return;
    const { counterparty } = flaggedAddress;
    setFlaggedAddress(null);
    complete(counterparty);
  }, [flaggedAddress, complete]);

  const value = useMemo(
    () => ({
      basics,
      submit,
      submitting,
      submitError,
      flaggedAddress,
      attachFlaggedAddress,
      skipFlaggedAddress,
    }),
    [
      basics,
      submit,
      submitting,
      submitError,
      flaggedAddress,
      attachFlaggedAddress,
      skipFlaggedAddress,
    ]
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
