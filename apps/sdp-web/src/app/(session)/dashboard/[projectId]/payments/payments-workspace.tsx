"use client";

import { paymentTransferSummarySchema } from "@sdp/types/payments";
import type { RampProviderId } from "@sdp/types/provider-access";
import dynamic from "next/dynamic";
import { z } from "zod";
import { ApiPlaygroundShellSkeleton } from "@/components/api-playground-shell-skeleton";
import { useTranslations } from "@/i18n/provider";
import {
  type DashboardReadError,
  useDashboardKeyScope,
  useDashboardRead,
} from "@/lib/dashboard-swr";
import { paymentsQueryKeys } from "./payments-query-key";
import { useCounterparties, useWalletSummaries } from "./shared-reads";

const PaymentsPlayground = dynamic(
  () => import("./payments-playground").then((module) => module.PaymentsPlayground),
  {
    loading: () => <ApiPlaygroundShellSkeleton />,
  }
);

const playgroundTransfersResponseSchema = z.object({
  data: z.array(paymentTransferSummarySchema),
});

// The id pickers offer the API's largest page of contacts.
const PLAYGROUND_CONTACTS_PAGE = { page: 1, pageSize: 100 } as const;
const PLAYGROUND_TRANSFERS_PAGE_SIZE = 20;

function readFailure(t: ReturnType<typeof useTranslations>, error: DashboardReadError) {
  return { status: error.status, error: error.code ?? t("DashboardPayments.page.unknownError") };
}

/**
 * The Payments playground, prefilled with the Project's wallets, recent transfers and contacts.
 * It waits for all three, and names whichever failed above the endpoints.
 */
export function PaymentsPlaygroundWorkspace({
  apiBaseUrl,
  rampProviders,
}: {
  apiBaseUrl: string | null;
  rampProviders: readonly RampProviderId[];
}) {
  const t = useTranslations();
  const scope = useDashboardKeyScope();
  const wallets = useWalletSummaries({ includeBalances: false });
  const transfers = useDashboardRead(
    paymentsQueryKeys.dashboardTransfers(scope, { pageSize: PLAYGROUND_TRANSFERS_PAGE_SIZE }),
    playgroundTransfersResponseSchema
  );
  const contacts = useCounterparties(PLAYGROUND_CONTACTS_PAGE);
  const reads = [wallets, transfers, contacts];
  if (reads.some((read) => read.data === undefined && read.error === undefined)) {
    return <ApiPlaygroundShellSkeleton />;
  }
  return (
    <PaymentsPlayground
      apiBaseUrl={apiBaseUrl}
      wallets={wallets.data ?? []}
      walletsError={
        wallets.error === undefined
          ? null
          : t("DashboardPayments.page.walletApiError", readFailure(t, wallets.error))
      }
      transfers={transfers.data?.data ?? []}
      transfersError={
        transfers.error === undefined
          ? null
          : t("DashboardPayments.page.transferApiError", readFailure(t, transfers.error))
      }
      counterparties={(contacts.data?.counterparties ?? []).map(({ id, displayName }) => ({
        id,
        displayName,
      }))}
      counterpartiesError={
        contacts.error === undefined
          ? null
          : t("DashboardPayments.page.counterpartyApiError", readFailure(t, contacts.error))
      }
      rampProviders={rampProviders}
    />
  );
}
