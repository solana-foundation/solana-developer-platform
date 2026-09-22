"use client";

/**
 * Funding the deposit MoneyGram asks for, mid-session.
 *
 * The custodial widget reports that MoneyGram allocated a deposit address and
 * waits for the signature of the transfer that funds it. Every refusal here has
 * to be a refusal MoneyGram can show, because the person is sitting in the
 * provider's flow: a deposit for another chain or asset, a wallet holding none
 * of the token, a payment a wallet policy parked, and a recorded transfer with
 * no signature are each said plainly rather than left to a generic failure.
 */

import { address } from "@solana/kit";
import {
  postMoneygramRampEvent,
  type Translate,
} from "@/app/dashboard/payments/payments-workspace.data";
import { sendTransferUnderKey } from "@/app/dashboard/payments/transfer-idempotency";

interface MoneygramTransferRequest {
  chain: string;
  asset: string;
  to: string;
  amount: string;
  memo?: string;
}

/** The deposit instruction the widget hands over once MoneyGram allocates an address. */
export interface MoneygramDepositAddress {
  address: string;
  memo?: string;
  chain: string;
  asset: string;
  amount?: string;
}

export interface MoneygramFundingContext {
  cryptoAsset: string;
  sessionId: string;
  sourceWalletId: string;
  /** The wallet's mint for the asset, or null when it holds none of it. */
  sourceTokenMint: string | null;
  /** Records the transfer the session signed, for the events that follow it. */
  onSigned: (transferId: string) => void;
  t: Translate;
}

async function sendMoneygramTransfer(
  request: MoneygramTransferRequest,
  context: MoneygramFundingContext
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

/**
 * Funds a custodial off-ramp. The widget payload only says a deposit address exists;
 * the address and amount actually sent to are the ones our API read from MoneyGram
 * under the secret key, so a tampered callback cannot redirect the transfer.
 *
 * @param deposit - What the widget reported; only its chain and asset are used.
 * @param context - The session's wallet, asset and translator.
 * @returns The signature the widget waits on.
 * @throws When the API has no deposit instruction for the session, or nothing was sent.
 */
export async function fundMoneygramDeposit(
  deposit: MoneygramDepositAddress,
  context: MoneygramFundingContext
): Promise<string> {
  const { sessionId, t } = context;
  const transfer = await postMoneygramRampEvent({ kind: "deposit_address", sessionId }, t);
  const depositAddress = transfer.moneygram?.depositAddress;
  const sendAmount = transfer.moneygram?.sendAmount;
  if (!depositAddress || !sendAmount) {
    throw new Error(t("DashboardPayments.ramps.moneygramDepositUnconfirmed"));
  }
  return sendMoneygramTransfer(
    {
      chain: deposit.chain,
      asset: deposit.asset,
      to: depositAddress,
      amount: sendAmount,
      memo: transfer.moneygram?.depositMemo,
    },
    context
  );
}
