"use client";

import type { Counterparty } from "@sdp/types/counterparties";
import type { RampProviderId } from "@sdp/types/provider-access";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useMemo, useState } from "react";
import { preload } from "swr";
import { counterpartyAccountsResponseSchema } from "@/app/(session)/dashboard/[projectId]/payments/counterparty/counterparty-read-schemas";
import {
  type CounterpartyOptions,
  useAllCounterparties,
} from "@/app/(session)/dashboard/[projectId]/payments/counterparty/use-all-counterparties";
import { paymentsQueryKeys } from "@/app/(session)/dashboard/[projectId]/payments/payments-query-key";
import {
  PaymentsDepositPageSkeleton,
  PaymentsPayPageSkeleton,
} from "@/app/(session)/dashboard/[projectId]/payments/payments-route-skeletons";
import {
  useIssuedTokens,
  useOrganizationProviderAccess,
  usePrivateChannelInstance,
} from "@/app/(session)/dashboard/[projectId]/payments/shared-reads";
import { useCanWrite, useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import type { DashboardRequestKey } from "@/lib/dashboard-request-key";
import { readDashboardRequest, useDashboardKeyScope } from "@/lib/dashboard-swr";
import {
  replaceDashboardSearchParams,
  useDashboardSearchParam,
  useDashboardTab,
} from "@/lib/dashboard-url-state";
import {
  filterEnabledRampProviderAccess,
  hasEnabledRampProvider,
  type RampProviderAccess,
} from "@/lib/provider-availability";
import { useProjectHref } from "@/lib/use-dashboard-project";
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
import { useRampsOffered } from "./use-ramps-offered";

interface PaymentsActionPageProps {
  mode: "send" | "receive";
  /** The ramp providers the channel-capped flags leave on (`getEnabledRampProviders`). */
  enabledRampProviders: RampProviderId[];
  /** Whether Issuance is on, so its tokens can name balances. */
  issuanceEnabled: boolean;
  /** Pay only: whether Private Channels is on, so the details step can say whether it sends privately. */
  privateChannelsEnabled?: boolean;
}

type WizardStep = { label: string; title: string };

export interface RailProps {
  issuedTokenSymbolsByMint: Record<string, string>;
  enabledRampProviders: RampProviderId[];
  rampProviderAccess: RampProviderAccess | null;
  counterparties: CounterpartyOptions;
  selectedCounterparty: Counterparty | null;
  counterpartyId: string;
  counterpartyName: string;
  methodLabel: string;
  preSteps: WizardStep[];
  onExit: () => void;
}

/** The organization's ramp provider access, as the flows read it. */
interface ProviderAccessState {
  /** Null when the read failed or was skipped: no access, so the provider flows stay off. */
  rampProviderAccess: RampProviderAccess | null;
  /** The read has answered (or was never needed). */
  settled: boolean;
}

/**
 * Pay and Deposit. Provider access serves only Ramps (the fiat rails) and Compliance (address
 * screening), so where neither runs here it is not read at all.
 */
export function PaymentsActionPage(props: PaymentsActionPageProps) {
  const rampsOffered = useRampsOffered();
  const complianceRuns = useDashboardWorkspace().flags.compliance;
  return rampsOffered || complianceRuns ? (
    <PaymentsActionPageWithProviderAccess {...props} />
  ) : (
    <PaymentsActionFlows {...props} providerAccess={{ rampProviderAccess: null, settled: true }} />
  );
}

function PaymentsActionPageWithProviderAccess(props: PaymentsActionPageProps) {
  const providerAccess = useOrganizationProviderAccess();
  return (
    <PaymentsActionFlows
      {...props}
      providerAccess={{
        // A failed read is no access: the provider flows stay off rather than open on a guess.
        rampProviderAccess:
          providerAccess.data === undefined
            ? null
            : filterEnabledRampProviderAccess(
                providerAccess.data.ramps,
                props.enabledRampProviders
              ),
        settled: providerAccess.data !== undefined || providerAccess.error !== undefined,
      }}
    />
  );
}

/**
 * The header's tabs pick the variant (Pay: Single / Batch; Deposit: Solana address / Card or
 * bank through a provider). Each flow opens on one details step with the contact inside it; a
 * single payment can hand off to a bank payout, and a deposit to an address needs no contact.
 */
function PaymentsActionFlows({
  providerAccess,
  ...props
}: PaymentsActionPageProps & { providerAccess: ProviderAccessState }) {
  const t = useTranslations();
  const { mode } = props;
  const router = useRouter();
  const href = useProjectHref();
  const tab = useDashboardTab();

  const searchParams = useSearchParams();
  // A contact's page opens Pay with that contact already picked.
  const [counterpartyId, setCounterpartyId] = useState(
    () => searchParams.get("counterpartyId") ?? ""
  );
  // Pay's fiat hand-off lives in the URL (`?method=bank`) beside the contact, so a refresh or
  // a shared link keeps both; a deposit's method comes from its tab. Without a contact the
  // bank payout has no one to pay, so the flow opens on the details step instead.
  const payByBank = useDashboardSearchParam("method") === "bank" && counterpartyId !== "";
  const exitToPayments = () => router.push(href("/dashboard/payments"));

  const scope = useDashboardKeyScope();
  const counterparties = useAllCounterparties();
  const liveCounterparties = counterparties.result;
  const issuedTokens = useIssuedTokens(props.issuanceEnabled);
  const issuedTokenSymbolsByMint = useMemo(
    () =>
      Object.fromEntries(
        (issuedTokens.data ?? []).map((token) => [token.mintAddress, token.symbol])
      ),
    [issuedTokens.data]
  );
  const { rampProviderAccess } = providerAccess;
  const instance = usePrivateChannelInstance(props.privateChannelsEnabled === true);
  const privateSend: PrivateSendStatus | null = !props.privateChannelsEnabled
    ? null
    : instance.data === undefined && instance.error === undefined
      ? null
      : // A failed read counts as not connected.
        { enabled: true, connected: instance.data?.isActive === true };

  const selectCounterparty = (id: string) => {
    setCounterpartyId(id);
    replaceDashboardSearchParams({ counterpartyId: id === "" ? null : id });
    if (!id) {
      return;
    }
    void preload(paymentsQueryKeys.counterpartyAccounts(scope, id), (key: DashboardRequestKey) =>
      readDashboardRequest(key, counterpartyAccountsResponseSchema)
    );
  };

  const rampsOffered = useRampsOffered();
  const fiatEnabled = rampsOffered && hasEnabledRampProvider(rampProviderAccess);
  // Without Ramps there is no provider tab, so a stale `?tab=provider` opens the address.
  const depositTab = rampsOffered ? tab : null;

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
    issuedTokenSymbolsByMint,
    enabledRampProviders: props.enabledRampProviders,
    rampProviderAccess,
    counterparties,
    selectedCounterparty,
    counterpartyId,
    counterpartyName,
    methodLabel,
    preSteps: [],
    onExit: exitToPayments,
  };
  const contact = {
    counterpartiesResult: liveCounterparties,
    loading: counterparties.loading,
    onRetry: counterparties.retry,
    onChange: selectCounterparty,
  };

  // Which flows open (an address, or a provider's) waits on provider access where Ramps runs, so
  // the page never opens one flow and swaps to the other.
  if (rampsOffered && !providerAccess.settled) {
    return mode === "send" ? <PaymentsPayPageSkeleton /> : <PaymentsDepositPageSkeleton />;
  }

  if (mode === "send") {
    return (
      <PayFlow
        tab={tab}
        method={effectiveMethod}
        railProps={railProps}
        contact={contact}
        privateSend={privateSend}
        fiatEnabled={fiatEnabled}
        onPayByBank={() => replaceDashboardSearchParams({ method: "bank" })}
        onLeaveBank={() => replaceDashboardSearchParams({ method: null })}
      />
    );
  }
  return (
    <DepositFlow
      tab={depositTab}
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
  const href = useProjectHref();
  // A read-only member has only the address tab; a provider deposit starts an on-ramp.
  const canWrite = useCanWrite();
  // A tab without a wizard frame lays out the same column the frame does: the shell's gutter,
  // 36px under the tabs (32px on a phone), the flow's width, and its own scrolling when it
  // outgrows the viewport.
  const tabColumn = (children: ReactNode) => (
    <div className="h-full min-h-0 overflow-y-auto px-4 pt-8 pb-16 md:px-6 md:pt-9">
      <div className="mx-auto w-full max-w-flow">{children}</div>
    </div>
  );
  if (canWrite && tab === "provider" && !fiatEnabled) {
    return tabColumn(
      <div className="space-y-2">
        <p className="text-body text-primary">{t("DashboardPayments.depositMethod.noProvider")}</p>
        <Link
          href={href("/dashboard/integrations")}
          className="text-body font-medium text-secondary hover:text-primary hover:underline"
        >
          {t("DashboardPayments.depositMethod.manageProviders")}
        </Link>
      </div>
    );
  }
  if (!canWrite || method === "onchain") {
    // The address tab needs no contact: anyone can send to a wallet address.
    return tabColumn(
      <DepositAddressPanel issuedTokenSymbolsByMint={railProps.issuedTokenSymbolsByMint} />
    );
  }

  // The provider tab picks its contact on its own details step.
  return <OnrampRail {...railProps} contact={contact} onCancel={railProps.onExit} />;
}
