"use client";

import { isCancelableRampTransferStatus } from "@sdp/types/payments";
import { WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types/well-known-tokens";
import { Button } from "@sdp/ui/button";
import { address } from "@solana/kit";
import { SendIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import useSWR, { useSWRConfig } from "swr";
import useSWRMutation from "swr/mutation";
import { paymentsQueryKeys } from "@/app/dashboard/[projectId]/payments/payments-query-key";
import {
  RecordList,
  RecordRow,
  RecordSection,
} from "@/app/dashboard/[projectId]/payments/payments-record";
import {
  type CreateTransferInput,
  cancelRampTransfer,
  createTransfer,
  fetchTransferById,
} from "@/app/dashboard/[projectId]/payments/payments-workspace.data";
import { CancelTransactionDialog } from "@/app/dashboard/[projectId]/payments/ramps/components/cancel-transaction-dialog";
import {
  OfframpSendError,
  SendDepositDialog,
} from "@/app/dashboard/[projectId]/payments/ramps/components/offramp-final-step";
import { submitOfframpDeposit } from "@/app/dashboard/[projectId]/payments/ramps/offramp-deposit";
import { rampTransferPollInterval } from "@/app/dashboard/[projectId]/payments/ramps/ramp-phase";
import { getRampTransferState } from "@/app/dashboard/[projectId]/payments/ramps/ramp-transfer-state";
import { useCanWrite } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import type { PaymentTransferDetail } from "./transaction-detail.data";

type RampTransferDetail = PaymentTransferDetail & { type: "onramp" | "offramp" };

function isRamp(transfer: PaymentTransferDetail | null): transfer is RampTransferDetail {
  return transfer?.type === "onramp" || transfer?.type === "offramp";
}

/** The status key a ramp in motion polls, or null once it can no longer change. */
function liveRampTransferKey(transfer: PaymentTransferDetail | null) {
  if (!isRamp(transfer) || getRampTransferState(transfer.status).terminal) return null;
  switch (transfer.type) {
    case "offramp":
      return paymentsQueryKeys.offrampTransferStatus({ transferId: transfer.id });
    case "onramp":
      return paymentsQueryKeys.onrampTransferStatus({ transferId: transfer.id });
    default: {
      const unhandled: never = transfer.type;
      throw new Error(`Unhandled ramp type: ${String(unhandled)}`);
    }
  }
}

/**
 * The page renders once on the server; a ramp still in motion keeps reading
 * its transfer, as the wizard does, so its state and actions stay current.
 */
export function useLiveRampTransfer(
  initial: PaymentTransferDetail | null
): PaymentTransferDetail | null {
  const t = useTranslations();
  const { data } = useSWR(
    liveRampTransferKey(initial),
    ([, transferId]: readonly [string, string]) => fetchTransferById({ transferId }, t),
    {
      // A fresh function each render re-arms SWR's timer with the latest transfer.
      refreshInterval: (transfer) => rampTransferPollInterval(transfer),
      revalidateOnFocus: false,
      revalidateOnMount: false,
      dedupingInterval: 2_000,
    }
  );
  return initial && data ? { ...initial, ...data } : initial;
}

/**
 * An open sale's own actions, so leaving the wizard never strands it: where
 * the deposit goes, sending it (confirmed first), and canceling the sale.
 */
export function RampOpenSale({
  transfer,
  walletLabel,
}: {
  transfer: PaymentTransferDetail;
  /** The wallet that pays the deposit, named in Send's confirmation. */
  walletLabel: string | null;
}) {
  const t = useTranslations();
  const router = useRouter();
  const canWrite = useCanWrite();
  const [confirmingSend, setConfirmingSend] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const { mutate } = useSWRConfig();
  const {
    trigger: send,
    data: sent,
    isMutating: sending,
    error: sendError,
  } = useSWRMutation(
    paymentsQueryKeys.createTransfer(),
    (_key, { arg }: { arg: CreateTransferInput }) => createTransfer(arg, t, null)
  );

  if (transfer.type !== "offramp" || !isCancelableRampTransferStatus(transfer.status)) {
    return null;
  }
  const deposit = transfer.cryptoDeposit;
  const token =
    (transfer.token ? WELL_KNOWN_TOKEN_BY_MINT.get(transfer.token)?.symbol : undefined) ??
    t("DashboardPayments.transactionDetail.theTokens");

  // The wizard and this page read the same transfer key; the server parts refresh with it.
  const refresh = async () => {
    await mutate(paymentsQueryKeys.offrampTransferStatus({ transferId: transfer.id }));
    router.refresh();
  };

  const sendDeposit = async () => {
    if (!deposit || !transfer.custodyWalletId || !transfer.token) return;
    await submitOfframpDeposit(
      {
        transferId: transfer.id,
        sourceCustodyWalletId: transfer.custodyWalletId,
        destination: deposit.destinationAddress,
        token: address(transfer.token),
        amount: deposit.amount,
      },
      send,
      t
    );
    await refresh();
  };

  const cancel = async () => {
    setConfirmingCancel(false);
    setCanceling(true);
    const toastId = toast.loading(t("DashboardPayments.ramps.cancelingTransaction"), {
      position: "bottom-right",
    });
    try {
      await cancelRampTransfer({ transferId: transfer.id }, t);
      toast.success(t("DashboardPayments.ramps.transactionCanceled"), {
        id: toastId,
        position: "bottom-right",
      });
      await refresh();
    } catch (error) {
      toast.error(t("DashboardPayments.ramps.unableToCancelTransaction"), {
        id: toastId,
        description:
          error instanceof Error ? error.message : t("DashboardPayments.ramps.cancellationFailed"),
        position: "bottom-right",
      });
    } finally {
      setCanceling(false);
    }
  };

  return (
    <RecordSection title={t("DashboardPayments.transactionDetail.openSale.title")}>
      {deposit ? (
        <RecordList>
          <RecordRow
            label={t("DashboardPayments.manualInstructions.depositAddress")}
            copy={deposit.destinationAddress}
          >
            <span className="tabular-nums">{deposit.destinationAddress}</span>
          </RecordRow>
          <RecordRow label={t("DashboardPayments.transactionDetail.openSale.depositAmount")}>
            {`${deposit.amount} ${token}`}
          </RecordRow>
        </RecordList>
      ) : null}
      <OfframpSendError message={sendError instanceof Error ? sendError.message : null} />
      {/* Send and Cancel both change the sale; a read-only member sees where it stands. */}
      {canWrite ? (
        <div className="mt-4 flex flex-wrap gap-3">
          {deposit && transfer.custodyWalletId && transfer.token ? (
            <Button
              type="button"
              iconLeft={<SendIcon />}
              disabled={sending || canceling || sent !== undefined}
              onClick={() => setConfirmingSend(true)}
            >
              {sending
                ? t("DashboardPayments.ramps.sending")
                : t("DashboardPayments.ramps.sendCrypto", { amount: deposit.amount, token })}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            iconLeft={<XIcon />}
            disabled={canceling || sending}
            onClick={() => setConfirmingCancel(true)}
          >
            {t("DashboardPayments.ramps.cancelPayout")}
          </Button>
        </div>
      ) : null}
      {deposit ? (
        <SendDepositDialog
          open={confirmingSend}
          provider={transfer.provider}
          depositTarget={deposit}
          token={token}
          walletLabel={walletLabel}
          onClose={() => setConfirmingSend(false)}
          onSend={() => {
            setConfirmingSend(false);
            void sendDeposit();
          }}
        />
      ) : null}
      <CancelTransactionDialog
        open={confirmingCancel}
        onKeepGoing={() => setConfirmingCancel(false)}
        onCancel={() => void cancel()}
      />
    </RecordSection>
  );
}
