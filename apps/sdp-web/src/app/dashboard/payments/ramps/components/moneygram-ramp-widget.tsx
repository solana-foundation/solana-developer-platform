"use client";

import { toNumberAmount } from "@sdp/solana/amount";
import type { MoneygramRampEvent, PaymentRampQuote } from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp-support";
import type { CryptoAssetSymbol } from "@sdp/types/payment-rails";
import { address } from "@solana/kit";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  createTransfer,
  postMoneygramRampEvent,
} from "@/app/dashboard/payments/payments-workspace.data";
import { useTranslations } from "@/i18n/provider";
import { MONEYGRAM_SDK_URL } from "@/lib/moneygram-sdk";
import {
  isTrustedRampDestination,
  MONEYGRAM_WIDGET_APPROVED_HOSTS,
} from "@/lib/trusted-ramp-destinations";

const SESSION_REFRESH_MS = 50 * 60 * 1000;

interface MoneygramOnChainTransaction {
  chain: string;
  to: string;
  amount: string;
  asset: string;
  memo?: string;
  rawTransaction: unknown;
}

interface MoneygramTransactionRecord {
  id: string;
  type: string;
  status: string;
  amount: number;
  referenceNumber?: string;
}

interface MoneygramWidgetError {
  transactionId?: string;
  reason: string;
}

interface MoneygramRampsConfig {
  container: HTMLElement;
  sessionToken: string;
  widgetUrl: string;
  wallet: {
    address: string;
    chain: "solana";
    asset: CryptoAssetSymbol;
    walletType: "custodial" | "non-custodial";
    displayName?: string;
  };
  transaction?: {
    type: "off-ramp" | "on-ramp";
    destinationCountry?: string;
    destinationSubdivision?: string;
    destinationCurrency?: string;
    amount?: number;
    asset?: CryptoAssetSymbol;
  };
  devConfig?: {
    apiBaseUrl: string;
    mockMode: boolean;
  };
  onSignTransaction: (tx: MoneygramOnChainTransaction) => Promise<string>;
  onComplete?: (transaction: MoneygramTransactionRecord) => void;
  onError?: (error: MoneygramWidgetError) => void;
  onClose?: () => void;
}

interface MoneygramRampsHandle {
  open(): void;
  close(): void;
  destroy(): void;
}

declare global {
  interface Window {
    RampsSDK?: {
      createRamps: (config: MoneygramRampsConfig) => MoneygramRampsHandle;
    };
  }
}

let rampsSdkPromise: Promise<NonNullable<Window["RampsSDK"]>> | null = null;

function loadRampsSdk(sdkUrl: string): Promise<NonNullable<Window["RampsSDK"]>> {
  if (window.RampsSDK) {
    return Promise.resolve(window.RampsSDK);
  }
  if (rampsSdkPromise) {
    return rampsSdkPromise;
  }
  rampsSdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = sdkUrl;
    script.async = true;
    script.addEventListener("load", () => {
      if (window.RampsSDK) {
        resolve(window.RampsSDK);
      } else {
        reject(new Error("MoneyGram SDK script loaded without exposing RampsSDK."));
      }
    });
    script.addEventListener("error", () =>
      reject(new Error("Failed to load the MoneyGram SDK script."))
    );
    document.head.appendChild(script);
  });
  rampsSdkPromise.catch(() => {
    rampsSdkPromise = null;
  });
  return rampsSdkPromise;
}

function buildOfframpTransactionPrefill(
  fiatCurrency: RampFiatCurrency,
  cryptoAsset: CryptoAssetSymbol,
  cryptoAmount: string
): MoneygramRampsConfig["transaction"] {
  const destinationCountry =
    fiatCurrency === "USD" ? "USA" : fiatCurrency === "MXN" ? "MEX" : undefined;
  return {
    type: "off-ramp",
    ...(destinationCountry ? { destinationCountry } : {}),
    destinationCurrency: fiatCurrency,
    amount: toNumberAmount(cryptoAmount),
    asset: cryptoAsset,
  };
}

function buildOnrampTransactionPrefill(
  fiatAmount: string,
  cryptoAsset: CryptoAssetSymbol
): MoneygramRampsConfig["transaction"] {
  return {
    type: "on-ramp",
    amount: toNumberAmount(fiatAmount),
    asset: cryptoAsset,
  };
}

export interface MoneygramRampWidgetProps {
  direction: "onramp" | "offramp";
  quote: Extract<PaymentRampQuote, { provider: "moneygram" }>;
  sourceWalletId: string;
  sourceWalletName: string;
  sourceWalletAddress: string;
  sourceTokenMint: string | null;
  cryptoAsset: CryptoAssetSymbol;
  cryptoAmount: string;
  fiatCurrency: RampFiatCurrency;
  onSessionExpiring: () => Promise<void>;
}

export function MoneygramRampWidget({
  direction,
  quote,
  sourceWalletId,
  sourceWalletName,
  sourceWalletAddress,
  sourceTokenMint,
  cryptoAsset,
  cryptoAmount,
  fiatCurrency,
  onSessionExpiring,
}: MoneygramRampWidgetProps) {
  const t = useTranslations();
  const containerRef = useRef<HTMLDivElement>(null);
  const signedTransferIdRef = useRef<string | null>(null);
  const onSessionExpiringRef = useRef(onSessionExpiring);
  onSessionExpiringRef.current = onSessionExpiring;
  const [loadError, setLoadError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the refresh timer restarts whenever a new session token is minted.
  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      if (signedTransferIdRef.current) {
        return;
      }
      void onSessionExpiringRef.current();
    }, SESSION_REFRESH_MS);
    return () => window.clearTimeout(timeoutId);
  }, [quote.sessionToken]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const { sessionId, sessionToken, widgetUrl } = quote;
    // The widget URL becomes the SDK's API base, so only HTTPS MoneyGram
    // widget hosts may ever be mounted — anything else fails closed.
    if (!isTrustedRampDestination(widgetUrl, MONEYGRAM_WIDGET_APPROVED_HOSTS)) {
      setLoadError(t("DashboardPayments.ramps.untrustedProviderUrl"));
      return;
    }
    const mountPoint = document.createElement("div");
    mountPoint.className = "h-full w-full";
    container.appendChild(mountPoint);
    let cancelled = false;
    let handle: MoneygramRampsHandle | null = null;

    const post = (event: MoneygramRampEvent) => {
      postMoneygramRampEvent(event, t).catch((error) => {
        toast.error(t("DashboardPayments.ramps.moneygramEventFailed"), {
          description:
            error instanceof Error
              ? error.message
              : t("DashboardPayments.ramps.eventRequestFailed"),
          position: "bottom-right",
        });
      });
    };

    loadRampsSdk(MONEYGRAM_SDK_URL)
      .then((sdk) => {
        if (cancelled) {
          return;
        }
        handle = sdk.createRamps({
          container: mountPoint,
          sessionToken,
          widgetUrl,
          devConfig: { apiBaseUrl: `${new URL(widgetUrl).origin}/api`, mockMode: false },
          wallet: {
            address: sourceWalletAddress,
            chain: "solana",
            asset: cryptoAsset,
            walletType: "custodial",
            displayName: sourceWalletName,
          },
          transaction:
            direction === "onramp"
              ? buildOnrampTransactionPrefill(cryptoAmount, cryptoAsset)
              : buildOfframpTransactionPrefill(fiatCurrency, cryptoAsset, cryptoAmount),
          onSignTransaction: async (tx) => {
            if (tx.chain !== "solana" || tx.asset !== cryptoAsset) {
              throw new Error(
                t("DashboardPayments.ramps.unsupportedMoneygramTransaction", {
                  asset: tx.asset,
                  chain: tx.chain,
                })
              );
            }
            if (!sourceTokenMint) {
              throw new Error(t("DashboardPayments.ramps.sourceWalletNoUsdc"));
            }
            const transfer = await createTransfer(
              {
                source: sourceWalletId,
                destination: tx.to,
                token: address(sourceTokenMint),
                amount: tx.amount,
                ...(tx.memo ? { memo: tx.memo } : {}),
              },
              t
            );
            if (!transfer.signature) {
              throw new Error(
                t("DashboardPayments.ramps.transferSignatureMissing", {
                  status: transfer.status,
                })
              );
            }
            signedTransferIdRef.current = transfer.id;
            await postMoneygramRampEvent(
              {
                kind: "signed",
                sessionId,
                cryptoTransferId: transfer.id,
              },
              t
            );
            return transfer.signature;
          },
          onComplete: (transaction) => {
            if (direction === "onramp") {
              post({
                kind: "onramp_completed",
                sessionId,
                transactionId: transaction.id,
                status: transaction.status,
                amount: transaction.amount,
                ...(transaction.referenceNumber
                  ? { referenceNumber: transaction.referenceNumber }
                  : {}),
              });
              return;
            }
            const cryptoTransferId = signedTransferIdRef.current;
            if (!cryptoTransferId) {
              toast.error(t("DashboardPayments.ramps.moneygramCompletionBeforeTransfer"), {
                position: "bottom-right",
              });
              return;
            }
            post({
              kind: "completed",
              sessionId,
              cryptoTransferId,
              transactionId: transaction.id,
              payoutAmount: transaction.amount,
              payoutStatus: transaction.status,
              ...(transaction.referenceNumber
                ? { referenceNumber: transaction.referenceNumber }
                : {}),
            });
          },
          onError: (error) => {
            const cryptoTransferId = signedTransferIdRef.current;
            post({
              kind: "errored",
              sessionId,
              reason: error.reason,
              ...(cryptoTransferId ? { cryptoTransferId } : {}),
              ...(error.transactionId ? { transactionId: error.transactionId } : {}),
            });
          },
          onClose: () => {
            post({ kind: "closed", sessionId });
          },
        });
        handle.open();
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(
            error instanceof Error
              ? error.message
              : t("DashboardPayments.ramps.moneygramWidgetLoadFailed")
          );
        }
      });

    return () => {
      cancelled = true;
      handle?.destroy();
      mountPoint.remove();
    };
  }, [
    quote,
    direction,
    fiatCurrency,
    cryptoAsset,
    sourceWalletId,
    sourceWalletName,
    sourceWalletAddress,
    sourceTokenMint,
    cryptoAmount,
    t,
  ]);

  if (loadError) {
    return (
      <div className="rounded-2xl border border-error-border bg-error-bg px-5 py-5 text-sm text-error">
        {loadError}
      </div>
    );
  }

  return <div ref={containerRef} className="relative h-160 w-full overflow-hidden rounded-2xl" />;
}
