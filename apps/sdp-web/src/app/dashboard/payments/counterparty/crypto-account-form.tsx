"use client";

import type { CounterpartyAccount, CounterpartyAccountResponse } from "@sdp/types";
import { Loader2Icon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ComplianceProviderResult } from "@/lib/compliance";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { getHighRiskProviders, runComplianceCheck } from "../payments-workspace.data";
import { ConfirmRiskyAccountDialog } from "./confirm-risky-account-dialog";
import { CRYPTO_ACCOUNT_NETWORKS, type CryptoAccountNetwork } from "./counterparty-create-schemas";

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

  const [screening, setScreening] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    providers: ComplianceProviderResult[];
    screened: boolean;
  } | null>(null);

  const trimmedAddress = address.trim();
  const busy = screening || submitting;

  async function createAccount() {
    setSubmitting(true);
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

    setSubmitting(false);

    if (!result.ok) {
      setConfirm(null);
      setError(result.error);
      toast.error(result.error, { position: "bottom-right" });
      return;
    }

    const account = result.data?.data?.account;
    if (account) onAdded?.(account);
    toast.success("Crypto account attached", { position: "bottom-right" });
    setLabel("");
    setAddress("");
    setConfirm(null);
  }

  async function handleAdd() {
    if (!trimmedAddress) return;
    setError(null);
    setScreening(true);

    let flagged: ComplianceProviderResult[] = [];
    let screened = true;
    try {
      const snapshot = await runComplianceCheck(trimmedAddress, "wallet_address_addition");
      flagged = getHighRiskProviders(snapshot);
    } catch {
      screened = false;
    } finally {
      setScreening(false);
    }

    if (!screened || flagged.length > 0) {
      setConfirm({ providers: flagged, screened });
      return;
    }
    await createAccount();
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
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>

      <Combobox
        label="Network"
        value={network}
        onChange={(next) => {
          const match = CRYPTO_ACCOUNT_NETWORKS.find((n) => n === next);
          if (match) setNetwork(match);
        }}
        options={NETWORK_OPTIONS}
        placeholder="Select network"
        searchable={false}
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
          onChange={(e) => setAddress(e.target.value)}
        />
      </div>

      {error && <p className="text-sm text-status-error-text">{error}</p>}

      {screening ? (
        <div className="flex items-center gap-2 text-sm text-text-medium">
          <Loader2Icon className="size-4 animate-spin" />
          Screening address for risk…
        </div>
      ) : (
        <Button
          type="button"
          onClick={() => void handleAdd()}
          disabled={busy || !trimmedAddress}
          iconLeft={submitting ? <Loader2Icon className="animate-spin" /> : <PlusIcon />}
        >
          {submitting ? "Adding" : "Add account"}
        </Button>
      )}

      <ConfirmRiskyAccountDialog
        isOpen={confirm !== null}
        providers={confirm?.providers ?? []}
        screened={confirm?.screened ?? true}
        onConfirm={createAccount}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}
