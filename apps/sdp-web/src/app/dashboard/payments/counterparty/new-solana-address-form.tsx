"use client";

import type { CounterpartyAccount, CounterpartyAccountResponse } from "@sdp/types";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslations } from "@/i18n/provider";
import { ComplianceNotEnabledError } from "@/lib/compliance";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { cn } from "@/lib/utils";
import { getHighRiskProviders, runComplianceCheck } from "../payments-workspace.data";
import { SOLANA_ADDRESS } from "./counterparty-create-schemas";

type Phase = "idle" | "screening" | "flagged" | "adding";

interface NewSolanaAddressFormProps {
  counterpartyId: string;
  /** Prefixes the fields' ids, so each form a page opens keeps its own. */
  idPrefix: string;
  /** Called with the saved address; the caller picks it and closes the form. */
  onAdded: (account: CounterpartyAccount) => void;
  onCancel: () => void;
  className?: string;
}

/**
 * "New Solana address", opened under the field that needs one, as the design does rather than in
 * a dialog: a label, the address, and one action that screens the address and saves it. A clean
 * screening saves straight away; a flag (or a screening that could not run) says so and leaves
 * the choice: add it anyway, or do not.
 */
export function NewSolanaAddressForm({
  counterpartyId,
  idPrefix,
  onAdded,
  onCancel,
  className,
}: NewSolanaAddressFormProps) {
  const t = useTranslations();
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [flag, setFlag] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const trimmedAddress = address.trim();
  const busy = phase === "screening" || phase === "adding";
  const flagged = phase === "flagged";
  const canSubmit = trimmedAddress !== "" && !busy;

  async function save() {
    setPhase("adding");
    const result = await dashboardFetch<{ data: CounterpartyAccountResponse }>(
      `/api/dashboard/counterparty/${encodeURIComponent(counterpartyId)}/accounts`,
      {
        method: "POST",
        body: {
          accountKind: "crypto_wallet",
          label: label.trim() || undefined,
          details: { network: "solana", address: trimmedAddress },
        },
      }
    );
    if (!result.ok) {
      setPhase("idle");
      setFlag(null);
      setError(result.error);
      return;
    }
    const account = result.data?.data?.account;
    toast.success(t("DashboardPayments.counterparty.addressAdded"));
    if (account) {
      onAdded(account);
    } else {
      onCancel();
    }
  }

  function raiseFlag(message: string) {
    setFlag(message);
    setPhase("flagged");
  }

  async function screenAndSave() {
    if (!SOLANA_ADDRESS.test(trimmedAddress)) {
      setError(t("DashboardPayments.counterparty.validation.invalidAddress"));
      return;
    }
    setError(null);
    setPhase("screening");
    try {
      const snapshot = await runComplianceCheck(trimmedAddress, "wallet_address_addition");
      if (snapshot.providers.length === 0) {
        raiseFlag(t("DashboardPayments.counterparty.screeningUnavailable"));
        return;
      }
      const problems = [
        ...getHighRiskProviders(snapshot),
        ...snapshot.providers.filter((provider) => provider.status !== "ok"),
      ];
      if (problems.length > 0) {
        raiseFlag(t("DashboardPayments.counterparty.screeningWarning"));
        return;
      }
      await save();
    } catch (screeningError) {
      raiseFlag(
        screeningError instanceof ComplianceNotEnabledError
          ? t("DashboardPayments.workspace.complianceNotEnabled")
          : t("DashboardPayments.counterparty.screeningUnavailable")
      );
    }
  }

  const primaryLabel =
    phase === "screening"
      ? t("DashboardPayments.counterparty.screening")
      : phase === "adding"
        ? t("DashboardPayments.counterparty.adding")
        : flagged
          ? t("DashboardPayments.counterparty.addAnyway")
          : t("DashboardPayments.counterparty.screenAndAdd");

  return (
    <div
      data-slot="new-solana-address"
      className={cn(
        "flex flex-col gap-4 rounded-[var(--corner-card)] border border-border-default p-4",
        className
      )}
    >
      <p className="mb-1 text-body font-medium text-primary">
        {t("DashboardPayments.counterparty.newSolanaAddress")}
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-label`}>{t("DashboardPayments.counterparty.label")}</Label>
        <Input
          id={`${idPrefix}-label`}
          size="xl"
          autoComplete="off"
          placeholder={t("DashboardPayments.counterparty.addressLabelPlaceholder")}
          value={label}
          disabled={busy}
          onChange={(event) => setLabel(event.currentTarget.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-address`}>{t("DashboardPayments.counterparty.address")}</Label>
        <Input
          id={`${idPrefix}-address`}
          size="xl"
          autoComplete="off"
          spellCheck={false}
          inputClassName="font-mono refresh:text-body placeholder:font-sans"
          placeholder={t("DashboardPayments.counterparty.addressPlaceholder")}
          value={address}
          disabled={busy}
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            setAddress(event.currentTarget.value);
            setError(null);
            // A changed address has not been screened.
            if (flagged) {
              setFlag(null);
              setPhase("idle");
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && canSubmit) {
              event.preventDefault();
              void (flagged ? save() : screenAndSave());
            }
          }}
        />
        {error ? <p className="text-body text-error">{error}</p> : null}
      </div>
      {flag ? <p className="text-body text-error">{flag}</p> : null}
      <div className="flex flex-wrap items-center justify-end gap-3 [--button-height-md:1.875rem]">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={phase === "adding"}
          onClick={onCancel}
        >
          {flagged
            ? t("DashboardPayments.counterparty.doNotAdd")
            : t("DashboardPayments.counterparty.cancel")}
        </Button>
        {/* An action that cannot run yet is the design's outline on the control wash, not a
            faded primary. */}
        <Button
          type="button"
          variant={flagged || !canSubmit ? "outline" : "default"}
          size="sm"
          disabled={!canSubmit}
          className={cn(!canSubmit && "opacity-100 text-tertiary refresh:bg-fill")}
          onClick={() => void (flagged ? save() : screenAndSave())}
        >
          {primaryLabel}
        </Button>
      </div>
    </div>
  );
}
