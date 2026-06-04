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
import { OfframpStepContent } from "./components/offramp-step-content";
import { OnchainReceiveStepContent } from "./components/onchain-receive-step-content";
import { OnchainSendStepContent } from "./components/onchain-send-step-content";
import { OnrampStepContent } from "./components/onramp-step-content";
import { type PaymentMethod, PaymentMethodStep } from "./components/payment-method-step";
import { PoweredByRampProvider, RampWizardShell } from "./components/ramp-wizard-shell";
import { OFFRAMP_STEPS, useOfframpWizard } from "./hooks/use-offramp-wizard";
import { ONCHAIN_RECEIVE_STEPS, useOnchainReceiveWizard } from "./hooks/use-onchain-receive-wizard";
import { ONCHAIN_SEND_STEPS, useOnchainSendWizard } from "./hooks/use-onchain-send-wizard";
import { ONRAMP_STEPS, useOnrampWizard } from "./hooks/use-onramp-wizard";

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

// ---- Rail children (mounted once the counterparty + method are known) ----

interface RailProps {
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  enabledRampProviders: RampProviderId[];
  counterpartiesResult: CounterpartiesResult;
  counterpartyId: string;
  counterpartyName: string;
  preSteps: WizardStep[];
  onExit: () => void;
}

function OnchainSendRail({
  wallets,
  walletsError,
  counterpartyId,
  counterpartyName,
  preSteps,
  onExit,
}: RailProps) {
  const wizard = useOnchainSendWizard({ wallets, walletsError, counterpartyId, onExit });
  const primaryLabel = wizard.submitting
    ? "Submitting..."
    : wizard.isLastStep
      ? wizard.transferResult
        ? "Done"
        : "Send transfer"
      : "Next";

  return (
    <RampWizardShell
      steps={[...preSteps, ...ONCHAIN_SEND_STEPS]}
      stepIndex={preSteps.length + wizard.stepIndex}
      primaryDisabled={wizard.submitting || !wizard.canProceed}
      primaryLabel={primaryLabel}
      walletsError={wizard.liveWalletsError}
      onPrimary={() => void wizard.handlePrimary()}
      onSecondary={wizard.handleSecondary}
      counterpartyDialogOpen={false}
      setCounterpartyDialogOpen={() => {}}
      onCounterpartyCreated={() => {}}
    >
      <OnchainSendStepContent wizard={wizard} counterpartyName={counterpartyName} />
    </RampWizardShell>
  );
}

function OfframpRail({
  wallets,
  walletsError,
  enabledRampProviders,
  counterpartiesResult,
  counterpartyId,
  preSteps,
  onExit,
}: RailProps) {
  const wizard = useOfframpWizard({
    wallets,
    walletsError,
    enabledRampProviders,
    counterpartiesResult,
    initialCounterpartyId: counterpartyId,
    onExit,
  });

  return (
    <RampWizardShell
      steps={[...preSteps, ...OFFRAMP_STEPS]}
      stepIndex={preSteps.length + wizard.stepIndex}
      primaryDisabled={
        wizard.hostedQuoteLoading ||
        !wizard.canProceed ||
        (wizard.currentStepId === "WALLET" && wizard.walletsLoading)
      }
      primaryLabel={wizard.hostedQuoteLoading ? "Opening..." : wizard.isLastStep ? "Done" : "Next"}
      walletsError={wizard.liveWalletsError}
      onPrimary={() => void wizard.handlePrimary()}
      onSecondary={wizard.handleSecondary}
      counterpartyDialogOpen={false}
      setCounterpartyDialogOpen={() => {}}
      onCounterpartyCreated={() => {}}
      footer={
        wizard.currentStepId === "COMPLETE" && wizard.quote ? (
          <PoweredByRampProvider provider={wizard.quote.provider} />
        ) : null
      }
    >
      <OfframpStepContent wizard={wizard} />
    </RampWizardShell>
  );
}

function OnchainReceiveRail({
  wallets,
  walletsError,
  counterpartyId,
  preSteps,
  onExit,
}: RailProps) {
  const wizard = useOnchainReceiveWizard({ wallets, walletsError, counterpartyId, onExit });

  return (
    <RampWizardShell
      steps={[...preSteps, ...ONCHAIN_RECEIVE_STEPS]}
      stepIndex={preSteps.length + wizard.stepIndex}
      primaryDisabled={
        !wizard.canProceed || (wizard.currentStepId === "WALLET" && wizard.walletsLoading)
      }
      primaryLabel={wizard.isLastStep ? "Done" : "Next"}
      walletsError={wizard.liveWalletsError}
      onPrimary={wizard.handlePrimary}
      onSecondary={wizard.handleSecondary}
      counterpartyDialogOpen={false}
      setCounterpartyDialogOpen={() => {}}
      onCounterpartyCreated={() => {}}
    >
      <OnchainReceiveStepContent wizard={wizard} />
    </RampWizardShell>
  );
}

function OnrampRail({
  wallets,
  walletsError,
  enabledRampProviders,
  counterpartiesResult,
  counterpartyId,
  preSteps,
  onExit,
}: RailProps) {
  const wizard = useOnrampWizard({
    wallets,
    walletsError,
    enabledRampProviders,
    counterpartiesResult,
    initialCounterpartyId: counterpartyId,
    onExit,
  });

  return (
    <RampWizardShell
      steps={[...preSteps, ...ONRAMP_STEPS]}
      stepIndex={preSteps.length + wizard.stepIndex}
      primaryDisabled={
        wizard.hostedQuoteLoading ||
        !wizard.canProceed ||
        (wizard.currentStepId === "DEPOSIT" && wizard.walletsLoading)
      }
      primaryLabel={wizard.hostedQuoteLoading ? "Opening..." : wizard.isLastStep ? "Done" : "Next"}
      walletsError={wizard.liveWalletsError}
      onPrimary={() => void wizard.handlePrimary()}
      onSecondary={wizard.handleSecondary}
      counterpartyDialogOpen={false}
      setCounterpartyDialogOpen={() => {}}
      onCounterpartyCreated={() => {}}
      footer={
        wizard.currentStepId === "PROVIDER" && wizard.quote ? (
          <PoweredByRampProvider provider={wizard.quote.provider} />
        ) : null
      }
    >
      <OnrampStepContent wizard={wizard} />
    </RampWizardShell>
  );
}

// ---- Orchestrator: counterparty -> method -> rail ----

type Phase = "counterparty" | "method" | "rail";

export function PaymentsActionPage(props: PaymentsActionPageProps) {
  const { mode, enabledRampProviders } = props;
  const router = useRouter();

  const [phase, setPhase] = useState<Phase>("counterparty");
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

    if (mode === "send") {
      return effectiveMethod === "onchain" ? (
        <OnchainSendRail {...railProps} />
      ) : (
        <OfframpRail {...railProps} />
      );
    }
    return effectiveMethod === "onchain" ? (
      <OnchainReceiveRail {...railProps} />
    ) : (
      <OnrampRail {...railProps} />
    );
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
        <CounterpartyPicker
          mode={mode}
          counterpartiesResult={liveCounterparties}
          value={counterpartyId || null}
          onChange={selectCounterparty}
          onAddClick={() => setCounterpartyDialogOpen(true)}
        />
      ) : (
        <PaymentMethodStep mode={mode} value={method} onChange={setMethod} />
      )}
    </RampWizardShell>
  );
}
