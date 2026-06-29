"use client";

import type { CounterpartyAccount, CounterpartyAccountResponse } from "@sdp/types";
import { CheckIcon, Loader2Icon, PlusIcon, ShieldAlertIcon } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { type ReactNode, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { HeightReveal } from "@/components/ui/height-reveal";
import { HoldButton } from "@/components/ui/hold-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { getHighRiskProviders, runComplianceCheck } from "../payments-workspace.data";
import type { ComplianceSnapshot } from "../payments-workspace.types";
import { CRYPTO_ACCOUNT_NETWORKS, type CryptoAccountNetwork } from "./counterparty-create-schemas";
import { ScreeningProgress } from "./screening-progress";

type AddPhase = "idle" | "screening" | "revealing" | "ready" | "submitting";

const NETWORK_LABELS: Record<CryptoAccountNetwork, string> = {
  solana: "Solana",
};

const NETWORK_OPTIONS = CRYPTO_ACCOUNT_NETWORKS.map((value) => ({
  value,
  label: NETWORK_LABELS[value],
}));

interface CryptoAccountFormProps {
  counterpartyId: string;
  onAdded?: (account: CounterpartyAccount) => void;
}

export function CryptoAccountForm({ counterpartyId, onAdded }: CryptoAccountFormProps) {
  const [label, setLabel] = useState("");
  const [network, setNetwork] = useState<CryptoAccountNetwork>("solana");
  const [address, setAddress] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<AddPhase>("idle");
  const [snapshot, setSnapshot] = useState<ComplianceSnapshot | null>(null);
  const [screenUnavailable, setScreenUnavailable] = useState(false);
  const submittingRef = useRef(false);

  const trimmedAddress = address.trim();
  const busy = phase === "screening" || phase === "revealing" || phase === "submitting";

  const problems = snapshot
    ? [
        ...getHighRiskProviders(snapshot),
        ...snapshot.providers.filter((provider) => provider.status !== "ok"),
      ]
    : [];
  const hasRisk = problems.length > 0 || screenUnavailable;

  const buttonState = ((): { label: string; icon: ReactNode } => {
    switch (phase) {
      case "submitting":
        return { label: "Adding", icon: <Loader2Icon className="animate-spin" /> };
      case "screening":
      case "revealing":
        return { label: "Screening", icon: <Loader2Icon className="animate-spin" /> };
      case "ready":
        return { label: "Add account", icon: <CheckIcon /> };
      case "idle":
        return { label: "Add account", icon: <PlusIcon /> };
    }
  })();

  function resetScreening() {
    setSnapshot(null);
    setScreenUnavailable(false);
    setPhase("idle");
  }

  function clearScreening() {
    if (phase === "idle" || phase === "submitting") return;
    resetScreening();
  }

  async function createAccount() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setPhase("submitting");
    setError(null);

    const result = await dashboardFetch<{ data: CounterpartyAccountResponse }>(
      `/api/dashboard/counterparty/${encodeURIComponent(counterpartyId)}/accounts`,
      {
        method: "POST",
        body: {
          accountKind: "crypto_wallet",
          label: label.trim() || undefined,
          details: { network, address: trimmedAddress },
        },
      }
    );

    submittingRef.current = false;

    if (!result.ok) {
      resetScreening();
      setError(result.error);
      toast.error(result.error, { position: "bottom-right" });
      return;
    }

    const account = result.data?.data?.account;
    if (account) onAdded?.(account);
    toast.success("Crypto account attached", { position: "bottom-right" });
    setLabel("");
    setAddress("");
    resetScreening();
  }

  async function handleAdd() {
    if (!trimmedAddress) return;
    setError(null);
    setScreenUnavailable(false);
    setSnapshot(null);
    setPhase("screening");

    try {
      const result = await runComplianceCheck(trimmedAddress, "wallet_address_addition");
      if (result.providers.length === 0) {
        setScreenUnavailable(true);
        setPhase("ready");
        return;
      }
      setSnapshot(result);
      setPhase("revealing");
    } catch {
      setScreenUnavailable(true);
      setPhase("ready");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2">
        <Label className="text-sm font-medium text-text-low" htmlFor="account-label">
          Label <span className="font-normal text-text-extra-low">(optional)</span>
        </Label>
        <Input
          id="account-label"
          size="xl"
          placeholder="e.g. Alice's Solana wallet"
          value={label}
          disabled={busy}
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>

      <Combobox
        label="Network"
        value={network}
        onChange={(next) => {
          const match = CRYPTO_ACCOUNT_NETWORKS.find((n) => n === next);
          if (match) setNetwork(match);
          clearScreening();
        }}
        options={NETWORK_OPTIONS}
        placeholder="Select network"
        searchable={false}
        disabled={busy}
      />

      <div className="flex flex-col gap-2">
        <Label className="text-sm font-medium text-text-low" htmlFor="account-address">
          Wallet address
        </Label>
        <Input
          id="account-address"
          size="xl"
          placeholder="Destination wallet address"
          value={address}
          disabled={busy}
          onChange={(e) => {
            setAddress(e.target.value);
            clearScreening();
          }}
        />
      </div>

      {error && <p className="text-sm text-status-error-text">{error}</p>}

      <AnimatePresence>
        {snapshot && (
          <ScreeningProgress
            key="screening"
            results={snapshot.providers}
            onComplete={() => setPhase("ready")}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {phase === "ready" && hasRisk && (
          <HeightReveal key="risk-warning" durationSeconds={0.25}>
            <p className="text-sm text-status-error-text">
              {screenUnavailable
                ? "We couldn't screen this address — compliance screening is unavailable. Add it anyway?"
                : "One or more checks flagged this wallet or couldn't be completed. Add it anyway?"}
            </p>
          </HeightReveal>
        )}
      </AnimatePresence>

      <div className="flex justify-end">
        {phase === "ready" && hasRisk ? (
          <HoldButton
            iconLeft={<ShieldAlertIcon className="size-3.5" />}
            onHoldComplete={() => void createAccount()}
          >
            Hold to add anyway
          </HoldButton>
        ) : (
          <Button
            type="button"
            onClick={() => (phase === "ready" ? void createAccount() : void handleAdd())}
            disabled={(phase !== "idle" && phase !== "ready") || !trimmedAddress}
            iconLeft={buttonState.icon}
          >
            {buttonState.label}
          </Button>
        )}
      </div>
    </div>
  );
}
