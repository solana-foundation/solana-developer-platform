"use client";

import type {
  ComplianceProviderId,
  Counterparty,
  PaymentsDashboardWallet,
  RampProviderId,
} from "@sdp/types";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
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
import type { PrivateSendStatus } from "./components/onchain-send-step-content";
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

  if (mode === "send") {
    if (tab === "batch") {
      return (
        <BatchSendRail
          wallets={props.wallets}
          walletsError={props.walletsError}
          issuedTokenSymbolsByMint={props.issuedTokenSymbolsByMint}
          onExit={exitToPayments}
        />
      );
    }
    const sendRailProps: RailProps = {
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
    if (effectiveMethod === "ramp") {
      // A bank payout keeps the contact picked on the details step; leaving it returns there.
      return <OfframpRail {...sendRailProps} onExit={() => setPayByBank(false)} />;
    }
    return (
      <OnchainSendRail
        {...sendRailProps}
        contact={{ counterpartiesResult: liveCounterparties, onChange: selectCounterparty }}
        privateSend={props.privateSend ?? null}
        onPayByBank={fiatEnabled ? () => setPayByBank(true) : undefined}
        onCancel={exitToPayments}
      />
    );
  }

  if (tab === "provider" && !fiatEnabled) {
    return (
      <div className="mx-auto w-full max-w-flow space-y-2 pt-2">
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
  if (effectiveMethod === "onchain") {
    // The address tab needs no contact: anyone can send to a wallet address.
    return (
      <div className="mx-auto w-full max-w-flow pt-2">
        <DepositAddressPanel
          wallets={props.wallets}
          walletsError={props.walletsError}
          issuedTokenSymbolsByMint={props.issuedTokenSymbolsByMint}
        />
      </div>
    );
  }

  // The provider tab picks its contact on its own details step.
  return (
    <OnrampRail
      wallets={props.wallets}
      walletsError={props.walletsError}
      issuedTokenSymbolsByMint={props.issuedTokenSymbolsByMint}
      enabledRampProviders={props.enabledRampProviders}
      rampProviderAccess={rampProviderAccess}
      counterpartiesResult={liveCounterparties}
      selectedCounterparty={selectedCounterparty}
      counterpartyId={counterpartyId}
      counterpartyName={counterpartyName}
      methodLabel={methodLabel}
      preSteps={[]}
      onExit={exitToPayments}
      contact={{ counterpartiesResult: liveCounterparties, onChange: selectCounterparty }}
      onCancel={exitToPayments}
    />
  );
}
