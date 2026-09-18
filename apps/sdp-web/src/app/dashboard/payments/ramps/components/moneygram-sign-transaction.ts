"use client";

/**
 * Signing the transfer MoneyGram asks for, mid-session.
 *
 * The widget hands over a transaction to sign and waits for a signature. Every
 * refusal here has to be a refusal MoneyGram can show, because the person is
 * sitting in the provider's flow: a transaction for another chain or asset, a
 * wallet holding none of the token, a payment a wallet policy parked, and a
 * recorded transfer with no signature are each said plainly rather than left
 * to a generic failure.
 */

import { address } from "@solana/kit";
import {
  postMoneygramRampEvent,
  type Translate,
} from "@/app/dashboard/payments/payments-workspace.data";
import { sendTransferUnderKey } from "@/app/dashboard/payments/transfer-idempotency";

/** The transaction the widget asks to have signed. */
export interface MoneygramSignRequest {
  chain: string;
  asset: string;
  to: string;
  amount: string;
  memo?: string;
}

export interface MoneygramSignContext {
  cryptoAsset: string;
  sessionId: string;
  sourceWalletId: string;
  /** The wallet's mint for the asset, or null when it holds none of it. */
  sourceTokenMint: string | null;
  /** Records the transfer the session signed, for the events that follow it. */
  onSigned: (transferId: string) => void;
  t: Translate;
}

/**
 * Sends the transfer MoneyGram asked for and answers with its signature.
 *
 * @param request - What the widget asked to sign.
 * @param context - The session's wallet, asset and translator.
 * @returns The signature the widget waits on.
 * @throws When nothing was sent, with a reason the widget can show.
 */
export async function signMoneygramTransfer(
  request: MoneygramSignRequest,
  context: MoneygramSignContext
): Promise<string> {
  const { cryptoAsset, sessionId, sourceWalletId, sourceTokenMint, onSigned, t } = context;
  if (request.chain !== "solana" || request.asset !== cryptoAsset) {
    throw new Error(
      t("DashboardPayments.ramps.unsupportedMoneygramTransaction", {
        asset: request.asset,
        chain: request.chain,
      })
    );
  }
  if (!sourceTokenMint) {
    throw new Error(t("DashboardPayments.ramps.sourceWalletNoUsdc"));
  }

  // The widget can ask to sign again while an approval still holds the first
  // attempt, and without a key each attempt is a new payment: approve two of
  // them and the money goes out twice.
  const { outcome } = await sendTransferUnderKey(
    {
      sourceCustodyWalletId: sourceWalletId,
      destination: request.to,
      token: address(sourceTokenMint),
      amount: request.amount,
      memo: request.memo,
    },
    t,
    sessionId
  );
  // MoneyGram needs a signature now and an approval answers later, so the
  // widget is told nothing moved rather than that the payment failed.
  if (outcome.kind === "approval_pending") {
    throw new Error(t("DashboardPayments.ramps.transferHeldForApproval"));
  }
  const transfer = outcome.transfer;
  if (!transfer.signature) {
    throw new Error(
      t("DashboardPayments.ramps.transferSignatureMissing", { status: transfer.status })
    );
  }
  onSigned(transfer.id);
  await postMoneygramRampEvent({ kind: "signed", sessionId, cryptoTransferId: transfer.id }, t);
  return transfer.signature;
}
