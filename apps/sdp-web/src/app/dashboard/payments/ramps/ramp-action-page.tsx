"use client";

import type {
  ComplianceProviderId,
  Counterparty,
  PaymentsDashboardWallet,
  RampProviderId,
} from "@sdp/types";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useMemo, useState } from "react";
import useSWR, { preload } from "swr";
import { paymentsQueryKeys } from "@/app/dashboard/payments/payments-query-key";
import {
  type CounterpartiesResult,
  fetchAllCounterparties,
  fetchCounterpartyAccounts,
} from "@/app/dashboard/payments/payments-workspace.data";
import { useTranslations } from "@/i18n/provider";
import { useDashboardTab } from "@/lib/dashboard-url-state";
import { hasEnabledRampProvider, type RampProviderAccess } from "@/lib/provider-availability";
import { BatchSendRail } from "./batch-send-rail";
import { DepositAddressPanel } from "./components/deposit-address-panel";
import type {
  OnchainSendContactControls,
  PrivateSendStatus,
} from "./components/onchain-send-step-content";
import { OfframpRail } from "./offramp-rail";
import { OnchainSendRail } from "./onchain-send-rail";
import { OnrampRail } from "./onramp-rail";
import { getPaymentMethodLabel, type PaymentMethod } from "./payment-method";

interface PaymentsActionPageProps {
  mode: "send" | "receive";
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  issuedTokenSymbolsByMint: Record<string, string>;
  enabledComplianceProviders: ComplianceProviderId[];
  enabledRampProviders: RampProviderId[];
  rampProviderAccess: RampProviderAccess | null;
  counterpartiesResult: CounterpartiesResult;
  /** Pay only: whether the project can send privately, for the details step's notice. */
  privateSend?: PrivateSendStatus | null;
}

type WizardStep = { label: string; title: string };

export interface RailProps {
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  issuedTokenSymbolsByMint: Record<string, string>;
  enabledRampProviders: RampProviderId[];
  rampProviderAccess: RampProviderAccess | null;
  counterpartiesResult: CounterpartiesResult;
  selectedCounterparty: Counterparty | null;
  counterpartyId: string;
  counterpartyName: string;
  methodLabel: string;
  preSteps: WizardStep[];
  onExit: () => void;
}

/**
 * Pay and Deposit. The header's tabs pick the variant (Pay: Single / Batch; Deposit: Solana
 * address / Card or bank through a provider). Each flow opens on one details step with the
 * contact inside it; a single payment can hand off to a bank payout, and a deposit to an
 * address needs no contact at all.
 */
export function PaymentsActionPage(props: PaymentsActionPageProps) {
  const t = useTranslations();
  const { mode, rampProviderAccess } = props;
  const router = useRouter();
  const tab = useDashboardTab();

  const [counterpartyId, setCounterpartyId] = useState("");
  // Pay's fiat hand-off; a deposit's method comes from its tab.
  const [payByBank, setPayByBank] = useState(false);
  const exitToPayments = () => router.push("/dashboard/payments");

  const { data: counterpartiesResult } = useSWR(
    paymentsQueryKeys.actionCounterparties(),
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
    void preload(paymentsQueryKeys.counterpartyAccounts({ counterpartyId: id }), () =>
      fetchCounterpartyAccounts(id, t)
    );
  };

  const fiatEnabled = hasEnabledRampProvider(rampProviderAccess);

  const effectiveMethod: PaymentMethod =
    mode === "send"
      ? payByBank && fiatEnabled
        ? "ramp"
        : "onchain"
      : tab === "provider" && fiatEnabled
        ? "ramp"
        : "onchain";
  const methodLabel = getPaymentMethodLabel(t, mode, effectiveMethod);
  const selectedCounterparty = useMemo(() => {
    const found = liveCounterparties.data.find((cp) => cp.id === counterpartyId);
    return found ? found : null;
  }, [liveCounterparties.data, counterpartyId]);
  const counterpartyName = selectedCounterparty ? selectedCounterparty.displayName : "";

  const railProps: RailProps = {
    wallets: props.wallets,
    walletsError: props.walletsError,
    issuedTokenSymbolsByMint: props.issuedTokenSymbolsByMint,
    enabledRampProviders: props.enabledRampProviders,
    rampProviderAccess,
    counterpartiesResult: liveCounterparties,
    selectedCounterparty,
    counterpartyId,
    counterpartyName,
    methodLabel,
    preSteps: [],
    onExit: exitToPayments,
  };
  const contact = { counterpartiesResult: liveCounterparties, onChange: selectCounterparty };

  if (mode === "send") {
    return (
      <PayFlow
        tab={tab}
        method={effectiveMethod}
        railProps={railProps}
        contact={contact}
        privateSend={props.privateSend ?? null}
        fiatEnabled={fiatEnabled}
        onPayByBank={() => setPayByBank(true)}
        onLeaveBank={() => setPayByBank(false)}
      />
    );
  }
  return (
    <DepositFlow
      tab={tab}
      method={effectiveMethod}
      railProps={railProps}
      contact={contact}
      fiatEnabled={fiatEnabled}
    />
  );
}

interface FlowProps {
  tab: string | null;
  method: PaymentMethod;
  railProps: RailProps;
  contact: OnchainSendContactControls;
  fiatEnabled: boolean;
}

/** Pay: a batch from a file, a bank payout through a provider, or a Solana transfer. */
function PayFlow({
  tab,
  method,
  railProps,
  contact,
  privateSend,
  fiatEnabled,
  onPayByBank,
  onLeaveBank,
}: FlowProps & {
  privateSend: PrivateSendStatus | null;
  onPayByBank: () => void;
  onLeaveBank: () => void;
}) {
  if (tab === "batch") {
    return (
      <BatchSendRail
        wallets={railProps.wallets}
        walletsError={railProps.walletsError}
        issuedTokenSymbolsByMint={railProps.issuedTokenSymbolsByMint}
        onExit={railProps.onExit}
      />
    );
  }
  if (method === "ramp") {
    // A bank payout keeps the contact picked on the details step; leaving it returns there.
    return <OfframpRail {...railProps} onExit={onLeaveBank} />;
  }
  return (
    <OnchainSendRail
      {...railProps}
      contact={contact}
      privateSend={privateSend}
      onPayByBank={fiatEnabled ? onPayByBank : undefined}
      onCancel={railProps.onExit}
    />
  );
}

/** Deposit: the wallet's address, or a card or bank payment through a provider. */
function DepositFlow({ tab, method, railProps, contact, fiatEnabled }: FlowProps) {
  const t = useTranslations();
  // A tab without a wizard frame lays out the same column the frame does: the shell's gutter,
  // 36px under the tabs (32px on a phone), the flow's width, and its own scrolling when it
  // outgrows the viewport.
  const tabColumn = (children: ReactNode) => (
    <div className="h-full min-h-0 overflow-y-auto px-4 pt-8 pb-16 md:px-6 md:pt-9">
      <div className="mx-auto w-full max-w-flow">{children}</div>
    </div>
  );
  if (tab === "provider" && !fiatEnabled) {
    return tabColumn(
      <div className="space-y-2">
        <p className="text-body text-primary">{t("DashboardPayments.depositMethod.noProvider")}</p>
        <Link
          href="/dashboard/integrations"
          className="text-body font-medium text-secondary hover:text-primary hover:underline"
        >
          {t("DashboardPayments.depositMethod.manageProviders")}
        </Link>
      </div>
    );
  }
  if (method === "onchain") {
    // The address tab needs no contact: anyone can send to a wallet address.
    return tabColumn(
      <DepositAddressPanel
        wallets={railProps.wallets}
        walletsError={railProps.walletsError}
        issuedTokenSymbolsByMint={railProps.issuedTokenSymbolsByMint}
      />
    );
  }

  // The provider tab picks its contact on its own details step.
  return <OnrampRail {...railProps} contact={contact} onCancel={railProps.onExit} />;
}
