"use client";

import type {
  ComplianceProviderId,
  Counterparty,
  PaymentsDashboardWallet,
  RampProviderId,
} from "@sdp/types";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import useSWR, { preload } from "swr";
import {
  type CounterpartiesResult,
  fetchAllCounterparties,
  fetchCounterpartyAccounts,
  fetchWallets,
} from "@/app/dashboard/payments/payments-workspace.data";
import { CounterpartyPicker } from "./components/counterparty-picker";
import { CounterpartyRecentTransfers } from "./components/counterparty-recent-transfers";
import { type PaymentMethod, PaymentMethodStep } from "./components/payment-method-step";
import { RampWizardShell } from "./components/ramp-wizard-shell";
import { OfframpRail } from "./offramp-rail";
import { OnchainReceiveRail } from "./onchain-receive-rail";
import { OnchainSendRail } from "./onchain-send-rail";
import { OnrampRail } from "./onramp-rail";

interface PaymentsActionPageProps {
  mode: "send" | "receive";
  actionLabel?: string;
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  issuedTokenSymbolsByMint: Record<string, string>;
  enabledComplianceProviders: ComplianceProviderId[];
  enabledRampProviders: RampProviderId[];
  counterpartiesResult: CounterpartiesResult;
}

type WizardStep = { label: string; title: string };

const PAYMENTS_ACTION_COUNTERPARTIES_KEY = "payments-action-counterparties";
const PAYMENTS_ACTION_WALLETS_KEY = "payments-action-wallets";

export interface RailProps {
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  enabledRampProviders: RampProviderId[];
  counterpartiesResult: CounterpartiesResult;
  counterpartyId: string;
  counterpartyName: string;
  preSteps: WizardStep[];
  onExit: () => void;
}

type RampsPhase = "counterparty" | "method" | "rail";

export function PaymentsActionPage(props: PaymentsActionPageProps) {
  const { mode, enabledRampProviders } = props;
  const router = useRouter();

  const [phase, setPhase] = useState<RampsPhase>("counterparty");
  const [counterpartyId, setCounterpartyId] = useState("");
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [counterpartyDialogOpen, setCounterpartyDialogOpen] = useState(false);

  const { data: counterpartiesResult, mutate: mutateCounterparties } = useSWR(
    PAYMENTS_ACTION_COUNTERPARTIES_KEY,
    fetchAllCounterparties,
    {
      fallbackData: props.counterpartiesResult,
      revalidateOnFocus: false,
      revalidateIfStale: false,
    }
  );
  const liveCounterparties = counterpartiesResult ?? props.counterpartiesResult;

  const selectCounterparty = (id: string) => {
    setCounterpartyId(id);
    if (!id) {
      return;
    }
    void preload(PAYMENTS_ACTION_WALLETS_KEY, () => fetchWallets({ includeBalances: true }));
    void preload(["counterparty-accounts", id], () => fetchCounterpartyAccounts(id));
  };

  const fiatEnabled = enabledRampProviders.length > 0;
  const availableMethods: PaymentMethod[] = fiatEnabled ? ["onchain", "ramp"] : ["onchain"];
  const showMethodStep = availableMethods.length > 1;

  const counterpartyTitle = mode === "send" ? "Who are you paying?" : "Who is this deposit from?";
  const methodTitle =
    mode === "send" ? "How would you like to pay?" : "How would you like to deposit?";

  const preSteps = useMemo<WizardStep[]>(
    () => [
      { label: "Counterparty", title: counterpartyTitle },
      ...(showMethodStep ? [{ label: "Method", title: methodTitle }] : []),
    ],
    [counterpartyTitle, methodTitle, showMethodStep]
  );

  const effectiveMethod: PaymentMethod = showMethodStep ? (method ?? "onchain") : "onchain";
  const counterpartyName =
    liveCounterparties.data.find((cp) => cp.id === counterpartyId)?.displayName ?? "";

  const handleCounterpartyCreated = (created: Counterparty) => {
    selectCounterparty(created.id);
    void mutateCounterparties(
      (prev) => (prev ? { ...prev, data: [created, ...prev.data] } : { ok: true, data: [created] }),
      { revalidate: true }
    );
    setCounterpartyDialogOpen(false);
  };

  const railOnExit = () => setPhase(showMethodStep ? "method" : "counterparty");

  if (phase === "rail") {
    const railProps: RailProps = {
      wallets: props.wallets,
      walletsError: props.walletsError,
      enabledRampProviders,
      counterpartiesResult: liveCounterparties,
      counterpartyId,
      counterpartyName,
      preSteps,
      onExit: railOnExit,
    };

    const railKey = `${mode}:${effectiveMethod}` as const;
    switch (railKey) {
      case "send:onchain":
        return <OnchainSendRail {...railProps} />;
      case "send:ramp":
        return <OfframpRail {...railProps} />;
      case "receive:onchain":
        return <OnchainReceiveRail {...railProps} />;
      case "receive:ramp":
        return <OnrampRail {...railProps} />;
      default: {
        const exhaustive: never = railKey;
        throw new Error(`Unhandled rail: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  const stepIndex = phase === "counterparty" ? 0 : 1;
  const primaryDisabled = phase === "counterparty" ? !counterpartyId : !method;
  const onPrimary = () => {
    if (phase === "counterparty") {
      if (!counterpartyId) {
        return;
      }
      setPhase(showMethodStep ? "method" : "rail");
      return;
    }
    if (!method) {
      return;
    }
    setPhase("rail");
  };
  const onSecondary = () => {
    if (phase === "counterparty") {
      router.push("/dashboard/payments");
      return;
    }
    setPhase("counterparty");
  };

  return (
    <RampWizardShell
      steps={preSteps}
      stepIndex={stepIndex}
      primaryDisabled={primaryDisabled}
      primaryLabel="Next"
      walletsError={null}
      onPrimary={onPrimary}
      onSecondary={onSecondary}
      counterpartyDialogOpen={counterpartyDialogOpen}
      setCounterpartyDialogOpen={setCounterpartyDialogOpen}
      onCounterpartyCreated={handleCounterpartyCreated}
    >
      {phase === "counterparty" ? (
        <>
          <CounterpartyPicker
            mode={mode}
            counterpartiesResult={liveCounterparties}
            value={counterpartyId || null}
            onChange={selectCounterparty}
            onAddClick={() => setCounterpartyDialogOpen(true)}
          />
          {counterpartyId ? <CounterpartyRecentTransfers counterpartyId={counterpartyId} /> : null}
        </>
      ) : (
        <PaymentMethodStep mode={mode} value={method} onChange={setMethod} />
      )}
    </RampWizardShell>
  );
}
