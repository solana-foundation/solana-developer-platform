"use client";

import { isCancelableRampTransferStatus } from "@sdp/types/payments";
import { WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types/well-known-tokens";
import { Button } from "@sdp/ui/button";
import { address } from "@solana/kit";
import { SendIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import useSWRMutation from "swr/mutation";
import {
  moneyMovementReads,
  paymentsQueryKeys,
} from "@/app/(session)/dashboard/[projectId]/payments/payments-query-key";
import {
  RecordList,
  RecordRow,
  RecordSection,
} from "@/app/(session)/dashboard/[projectId]/payments/payments-record";
import {
  type CreateTransferInput,
  cancelRampTransfer,
  createTransfer,
} from "@/app/(session)/dashboard/[projectId]/payments/payments-workspace.data";
import { CancelTransactionDialog } from "@/app/(session)/dashboard/[projectId]/payments/ramps/components/cancel-transaction-dialog";
import {
  OfframpSendError,
  SendDepositDialog,
} from "@/app/(session)/dashboard/[projectId]/payments/ramps/components/offramp-final-step";
import { submitOfframpDeposit } from "@/app/(session)/dashboard/[projectId]/payments/ramps/offramp-deposit";
import { useCanWrite } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { useInvalidateDashboardReads } from "@/lib/dashboard-swr";
import type { PaymentTransferDetail } from "./transaction-detail.data";

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
  const canWrite = useCanWrite();
  const [confirmingSend, setConfirmingSend] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const invalidateReads = useInvalidateDashboardReads();
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

  // The wizard and this page read the same transfer, and the ledger row beside it.
  const refresh = () => invalidateReads(moneyMovementReads);

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
              disabled={canceling || sent !== undefined}
              loading={sending}
              onClick={() => setConfirmingSend(true)}
            >
              {t("DashboardPayments.ramps.sendCrypto", { amount: deposit.amount, token })}
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
