"use client";

import type { Counterparty, MoneygramRampEvent, PaymentRampQuote } from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp-support";
import type { CryptoAssetSymbol } from "@sdp/types/payment-rails";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  createTransfer,
  postMoneygramRampEvent,
} from "@/app/dashboard/payments/payments-workspace.data";

const SESSION_REFRESH_MS = 50 * 60 * 1000;

const MONEYGRAM_DESTINATION_BY_FIAT = {
  USD: "USA",
  MXN: "MEX",
} as const satisfies Partial<Record<RampFiatCurrency, string>>;

const MONEYGRAM_ALPHA3_BY_ALPHA2 = {
  US: "USA",
  MX: "MEX",
  CA: "CAN",
} as const;

function toMoneygramAlpha3(alpha2: string): string | undefined {
  return MONEYGRAM_ALPHA3_BY_ALPHA2[alpha2 as keyof typeof MONEYGRAM_ALPHA3_BY_ALPHA2];
}

function toMoneygramSubdivision(alpha2CountryCode: string, subdivisionCode: string): string {
  return subdivisionCode.includes("-")
    ? subdivisionCode.toUpperCase()
    : `${alpha2CountryCode.toUpperCase()}-${subdivisionCode.toUpperCase()}`;
}

function resolveDestinationSubdivision(
  destinationCountry: string | undefined,
  counterparty: Counterparty | null
): string | undefined {
  if (!destinationCountry || !counterparty) {
    return undefined;
  }
  const address = counterparty.identity.address;
  if (!address?.subdivisionCode) {
    return undefined;
  }
  if (toMoneygramAlpha3(address.countryCode) !== destinationCountry) {
    return undefined;
  }
  return toMoneygramSubdivision(address.countryCode, address.subdivisionCode);
}

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
  customer?: {
    firstName?: string;
    middleName?: string;
    lastName?: string;
    secondLastName?: string;
    email?: string;
    phone?: string;
    dateOfBirth?: string;
    addressLine1?: string;
    city?: string;
    postalCode?: string;
    countryCode?: string;
    countrySubdivisionCode?: string;
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

function compactStrings(fields: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "string" && value) {
      result[key] = value;
    }
  }
  return result;
}

function buildCustomerPrefill(counterparty: Counterparty | null): MoneygramRampsConfig["customer"] {
  if (!counterparty) {
    return undefined;
  }
  const identity = counterparty.identity;
  const address = identity.address;
  return {
    ...compactStrings({
      firstName: identity.firstName,
      middleName: identity.middleName,
      lastName: identity.lastName,
      secondLastName: identity.secondLastName,
      dateOfBirth: identity.dateOfBirth,
      phone: identity.phone,
    }),
    email: counterparty.email,
    ...(address
      ? {
          addressLine1: address.line1,
          city: address.city,
          ...compactStrings({
            postalCode: address.postalCode,
            countryCode: toMoneygramAlpha3(address.countryCode),
            countrySubdivisionCode: address.subdivisionCode
              ? toMoneygramSubdivision(address.countryCode, address.subdivisionCode)
              : undefined,
          }),
        }
      : {}),
  };
}

function buildOfframpTransactionPrefill(
  fiatCurrency: RampFiatCurrency,
  cryptoAsset: CryptoAssetSymbol,
  cryptoAmount: string,
  counterparty: Counterparty | null
): MoneygramRampsConfig["transaction"] {
  const destinationCountry =
    MONEYGRAM_DESTINATION_BY_FIAT[fiatCurrency as keyof typeof MONEYGRAM_DESTINATION_BY_FIAT];
  const destinationSubdivision = resolveDestinationSubdivision(destinationCountry, counterparty);
  return {
    type: "off-ramp",
    ...(destinationCountry && destinationSubdivision
      ? { destinationCountry, destinationSubdivision }
      : {}),
    destinationCurrency: fiatCurrency,
    amount: Number.parseFloat(cryptoAmount),
    asset: cryptoAsset,
  };
}

export interface MoneygramRampWidgetProps {
  quote: Extract<PaymentRampQuote, { deliveryMode: "session_widget" }>;
  counterparty: Counterparty | null;
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
  quote,
  counterparty,
  sourceWalletId,
  sourceWalletName,
  sourceWalletAddress,
  sourceTokenMint,
  cryptoAsset,
  cryptoAmount,
  fiatCurrency,
  onSessionExpiring,
}: MoneygramRampWidgetProps) {
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
    const { sessionId, sessionToken, widgetUrl, sdkUrl } = quote;
    let cancelled = false;
    let handle: MoneygramRampsHandle | null = null;

    const post = (event: MoneygramRampEvent) => {
      postMoneygramRampEvent(event).catch((error) => {
        toast.error("Failed to record MoneyGram event.", {
          description: error instanceof Error ? error.message : "Event request failed.",
          position: "bottom-right",
        });
      });
    };

    loadRampsSdk(sdkUrl)
      .then((sdk) => {
        if (cancelled) {
          return;
        }
        handle = sdk.createRamps({
          container,
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
          customer: buildCustomerPrefill(counterparty),
          transaction: buildOfframpTransactionPrefill(
            fiatCurrency,
            cryptoAsset,
            cryptoAmount,
            counterparty
          ),
          onSignTransaction: async (tx) => {
            if (tx.chain !== "solana" || tx.asset !== cryptoAsset) {
              throw new Error(`Unsupported transaction: ${tx.asset} on ${tx.chain}.`);
            }
            if (!sourceTokenMint) {
              throw new Error("Source wallet has no USDC balance to send.");
            }
            const transfer = await createTransfer({
              source: sourceWalletId,
              destination: tx.to,
              token: sourceTokenMint,
              amount: tx.amount,
              ...(tx.memo ? { memo: tx.memo } : {}),
            });
            if (!transfer.signature) {
              throw new Error(`Transfer did not return a signature (status: ${transfer.status}).`);
            }
            signedTransferIdRef.current = transfer.id;
            await postMoneygramRampEvent({
              kind: "signed",
              sessionId,
              cryptoTransferId: transfer.id,
            });
            return transfer.signature;
          },
          onComplete: (transaction) => {
            const cryptoTransferId = signedTransferIdRef.current;
            if (!cryptoTransferId) {
              toast.error(
                "MoneyGram reported completion before the crypto transfer was recorded.",
                { position: "bottom-right" }
              );
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
            error instanceof Error ? error.message : "Failed to load the MoneyGram widget."
          );
        }
      });

    return () => {
      cancelled = true;
      handle?.destroy();
    };
  }, [
    quote,
    counterparty,
    fiatCurrency,
    cryptoAsset,
    sourceWalletId,
    sourceWalletName,
    sourceWalletAddress,
    sourceTokenMint,
    cryptoAmount,
  ]);

  if (loadError) {
    return (
      <div className="rounded-2xl border border-status-error-border bg-status-error-bg px-5 py-5 text-sm text-status-error-text">
        {loadError}
      </div>
    );
  }

  return <div ref={containerRef} className="relative h-160 w-full overflow-hidden rounded-2xl" />;
}
