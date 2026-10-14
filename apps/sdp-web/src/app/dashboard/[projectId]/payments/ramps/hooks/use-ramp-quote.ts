"use client";

import type { PaymentRampQuote } from "@sdp/types";
import { useEffect, useRef, useState } from "react";
import {
  cancelRampTransfer,
  getApiError,
} from "@/app/dashboard/[projectId]/payments/payments-workspace.data";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { dashboardFetch } from "@/lib/dashboard-fetch";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

interface CreatedRampQuote {
  quote: PaymentRampQuote;
  transferId: string;
}

async function createRampQuote(
  endpoint: string,
  payload: Record<string, unknown>,
  t: Translate
): Promise<CreatedRampQuote> {
  const result = await dashboardFetch<{
    data?: { quote?: PaymentRampQuote; transferId?: string };
  } | null>(endpoint, { method: "POST", body: payload });

  if (!result.ok) {
    throw new Error(
      result.status === null
        ? result.error
        : getApiError(
            result.body,
            t("DashboardPayments.ramps.quoteRequestFailedStatus", { status: result.status })
          )
    );
  }

  const quote = result.data?.data?.quote;
  const transferId = result.data?.data?.transferId;
  if (!quote || !transferId) {
    throw new Error(t("DashboardPayments.ramps.quoteResponseMissingDetails"));
  }
  return { quote, transferId };
}

interface UseRampQuoteOptions {
  endpoint: string;
  /** The quote request for the current selection, or null while it is incomplete. */
  payload: Record<string, unknown> | null;
  /** True while the wizard sits on the transaction stage with the provider ready. */
  shouldCreate: boolean;
  onCreated?: (quote: PaymentRampQuote) => void;
}

/**
 * The ramp wizard's quote (APE-466). It fires once per selection when
 * `shouldCreate` turns true; the quote POST persists the transfer and the
 * transfer-status poll owns the flow from there. A failed attempt surfaces
 * through `quoteCreationError` with an explicit retry.
 *
 * A response commits only while its request is still the latest one, so a
 * request the user navigated away from never becomes the quote, and
 * `invalidateQuote` (Previous from the transaction stage) abandons it and lets
 * the next arrival quote the edited selection. The server persisted the
 * abandoned request's transfer, so it is canceled when the response lands.
 */
export function useRampQuote({ endpoint, payload, shouldCreate, onCreated }: UseRampQuoteOptions) {
  const t = useTranslations();
  const [created, setCreated] = useState<CreatedRampQuote | null>(null);
  const [quoteCreationError, setQuoteCreationError] = useState<Error | null>(null);
  const [quoteCreationRetrying, setQuoteCreationRetrying] = useState(false);
  const attempted = useRef(false);
  const latestRequest = useRef(0);

  const runQuoteCreation = async () => {
    if (payload === null) {
      return;
    }
    const request = ++latestRequest.current;
    setQuoteCreationRetrying(true);
    try {
      const next = await createRampQuote(endpoint, payload, t);
      if (request !== latestRequest.current) {
        // Nobody will see this transfer. A cancel that fails leaves it to expiry (HOO-2040).
        void cancelRampTransfer({ transferId: next.transferId }, t).catch((cause: unknown) => {
          console.error("Failed to cancel the transfer of an abandoned ramp quote", cause);
        });
        return;
      }
      setCreated(next);
      setQuoteCreationError(null);
      onCreated?.(next.quote);
    } catch (error) {
      if (request === latestRequest.current) {
        setQuoteCreationError(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      if (request === latestRequest.current) {
        setQuoteCreationRetrying(false);
      }
    }
  };

  // Provider readiness arrives through the requirements status poll, so firing
  // the quote is a network side effect of that data arriving, not derived state.
  // react-doctor-disable-next-line no-fetch-in-effect, no-set-state-after-await-in-effect -- the quote is a side effect of readiness arriving; `attempted` bounds it to one request per selection
  useEffect(() => {
    if (!shouldCreate || attempted.current) {
      return;
    }
    attempted.current = true;
    // react-doctor-disable-next-line no-pass-live-state-to-parent -- `onCreated` reports the committed quote, not live state
    void runQuoteCreation();
  });

  const invalidateQuote = () => {
    latestRequest.current += 1;
    attempted.current = false;
    setCreated(null);
    setQuoteCreationError(null);
    setQuoteCreationRetrying(false);
  };

  return {
    quote: created === null ? null : created.quote,
    quoteTransferId: created === null ? null : created.transferId,
    quoteCreationError,
    quoteCreationRetrying,
    retryQuoteCreation: () => void runQuoteCreation(),
    invalidateQuote,
  };
}
