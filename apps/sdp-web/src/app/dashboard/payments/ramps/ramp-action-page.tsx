"use client";

import type { ComplianceProviderId, Counterparty, PaymentsDashboardWallet } from "@sdp/types";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import useSWR, { preload } from "swr";
import {
  type CounterpartiesResult,
  fetchAllCounterparties,
  fetchCounterpartyAccounts,
  fetchWallets,
} from "@/app/dashboard/payments/payments-workspace.data";
import { useTranslations } from "@/i18n/provider";
import { hasEnabledRampProvider, type RampProviderAccess } from "@/lib/provider-availability";
import { BatchSendRail } from "./batch-send-rail";
import { CounterpartyPicker } from "./components/counterparty-picker";
import { CounterpartyRecentTransfers } from "./components/counterparty-recent-transfers";
import { type PaymentMethod, PaymentMethodStep } from "./components/payment-method-step";
import { RampWizardShell } from "./components/ramp-wizard-shell";
import { type SendMode, SendModeToggle } from "./components/send-mode-toggle";
import { PAYMENTS_ACTION_WALLETS_KEY } from "./hooks/use-payments-action-wallets";
import { OfframpRail } from "./offramp-rail";
import { OnchainReceiveRail } from "./onchain-receive-rail";
import { OnchainSendRail } from "./onchain-send-rail";
import { OnrampRail } from "./onramp-rail";

interface PaymentsActionPageProps {
  mode: "send" | "receive";
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  issuedTokenSymbolsByMint: Record<string, string>;
  enabledComplianceProviders: ComplianceProviderId[];
  rampProviderAccess: RampProviderAccess | null;
  counterpartiesResult: CounterpartiesResult;
}

type WizardStep = { label: string; title: string };

const PAYMENTS_ACTION_COUNTERPARTIES_KEY = "payments-action-counterparties";

export interface RailProps {
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  issuedTokenSymbolsByMint: Record<string, string>;
  rampProviderAccess: RampProviderAccess | null;
  counterpartiesResult: CounterpartiesResult;
  selectedCounterparty: Counterparty | null;
  counterpartyId: string;
  counterpartyName: string;
  preSteps: WizardStep[];
  onExit: () => void;
}

type RampsPhase = "counterparty" | "method" | "rail";

export function PaymentsActionPage(props: PaymentsActionPageProps) {
  const t = useTranslations();
  const { mode, rampProviderAccess } = props;
  const router = useRouter();

  const [phase, setPhase] = useState<RampsPhase>("counterparty");
  const [sendMode, setSendMode] = useState<SendMode>("single");
  const [counterpartyId, setCounterpartyId] = useState("");
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [counterpartyDialogOpen, setCounterpartyDialogOpen] = useState(false);

  const { data: counterpartiesResult, mutate: mutateCounterparties } = useSWR(
    PAYMENTS_ACTION_COUNTERPARTIES_KEY,
    fetchAllCounterparties,
    {
      fallbackData: props.counterpartiesResult,
    }
  );
  const liveCounterparties = counterpartiesResult ?? props.counterpartiesResult;

  const selectCounterparty = (id: string) => {
    setCounterpartyId(id);
    if (!id) {
      return;
    }
    void preload(PAYMENTS_ACTION_WALLETS_KEY, () => fetchWallets({ includeBalances: true }, t));
    void preload(["counterparty-accounts", id], () => fetchCounterpartyAccounts(id, t));
  };

  const fiatEnabled = hasEnabledRampProvider(rampProviderAccess);
  const availableMethods: PaymentMethod[] = fiatEnabled ? ["onchain", "ramp"] : ["onchain"];
  const showMethodStep = availableMethods.length > 1;

  const counterpartyTitle =
    mode === "send"
      ? t("DashboardPayments.whoAreYouPaying")
      : t("DashboardPayments.whoIsThisDepositFrom");
  const methodTitle =
    mode === "send"
      ? t("DashboardPayments.howWouldYouLikeToPay")
      : t("DashboardPayments.howWouldYouLikeToDeposit");

  const preSteps = useMemo<WizardStep[]>(
    () => [
      { label: t("DashboardPayments.counterpartyLabel"), title: counterpartyTitle },
      ...(showMethodStep ? [{ label: t("DashboardPayments.method"), title: methodTitle }] : []),
    ],
    [counterpartyTitle, methodTitle, showMethodStep, t]
  );

  const effectiveMethod: PaymentMethod = showMethodStep ? (method ?? "onchain") : "onchain";
  const selectedCounterparty = useMemo(() => {
    const found = liveCounterparties.data.find((cp) => cp.id === counterpartyId);
    return found ? found : null;
  }, [liveCounterparties.data, counterpartyId]);
  const counterpartyName = selectedCounterparty ? selectedCounterparty.displayName : "";

  const handleCounterpartyCreated = (created: Counterparty) => {
    selectCounterparty(created.id);
    void mutateCounterparties(
      (prev) => (prev ? { ...prev, data: [created, ...prev.data] } : { ok: true, data: [created] }),
      { revalidate: true }
    );
    setCounterpartyDialogOpen(false);
  };

  const railOnExit = () => setPhase(showMethodStep ? "method" : "counterparty");

  if (mode === "send" && sendMode === "batch") {
    return (
      <BatchSendRail
        wallets={props.wallets}
        walletsError={props.walletsError}
        issuedTokenSymbolsByMint={props.issuedTokenSymbolsByMint}
        onExit={() => router.push("/dashboard/payments")}
        sendMode={sendMode}
        onSendModeChange={setSendMode}
      />
    );
  }

  if (phase === "rail") {
    const railProps: RailProps = {
      wallets: props.wallets,
      walletsError: props.walletsError,
      issuedTokenSymbolsByMint: props.issuedTokenSymbolsByMint,
      rampProviderAccess,
      counterpartiesResult: liveCounterparties,
      selectedCounterparty,
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
      primaryLabel={t("DashboardPayments.counterparty.next")}
      walletsError={null}
      onPrimary={onPrimary}
      onSecondary={onSecondary}
      counterpartyDialogOpen={counterpartyDialogOpen}
      setCounterpartyDialogOpen={setCounterpartyDialogOpen}
      onCounterpartyCreated={handleCounterpartyCreated}
      header={
        mode === "send" && phase === "counterparty" ? (
          <SendModeToggle value={sendMode} onChange={setSendMode} />
        ) : undefined
      }
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
