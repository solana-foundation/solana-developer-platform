"use client";

import type { PaymentRampQuote } from "@sdp/types";
import { useEffect, useRef, useState } from "react";
import { getApiError } from "@/app/dashboard/[projectId]/payments/payments-workspace.data";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { dashboardRequest } from "@/lib/dashboard-fetch";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

interface CreatedRampQuote {
  quote: PaymentRampQuote;
  transferId: string;
}

async function createRampQuote(
  endpoint: string,
  payload: Record<string, unknown>,
  signal: AbortSignal,
  t: Translate
): Promise<CreatedRampQuote> {
  const response = await dashboardRequest(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  const body: unknown = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      getApiError(
        body,
        t("DashboardPayments.ramps.quoteRequestFailedStatus", { status: response.status })
      )
    );
  }

  // SAFETY: the dashboard route returns the API's quote response unchanged, so
  // its shape is the API's own contract; both fields read here are checked below.
  const envelope = body as { data?: { quote?: PaymentRampQuote; transferId?: string } } | null;
  const quote = envelope?.data?.quote;
  const transferId = envelope?.data?.transferId;
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
 * A response commits only while its request is still the pending one, so a
 * request the user navigated away from never becomes the quote, and
 * `invalidateQuote` (Previous from the transaction stage) aborts it and lets
 * the next arrival quote the edited selection.
 */
export function useRampQuote({ endpoint, payload, shouldCreate, onCreated }: UseRampQuoteOptions) {
  const t = useTranslations();
  const [created, setCreated] = useState<CreatedRampQuote | null>(null);
  const [quoteCreationError, setQuoteCreationError] = useState<Error | null>(null);
  const [quoteCreationRetrying, setQuoteCreationRetrying] = useState(false);
  const attempted = useRef(false);
  const pending = useRef<AbortController | null>(null);

  const runQuoteCreation = async () => {
    if (payload === null) {
      return;
    }
    pending.current?.abort();
    const request = new AbortController();
    pending.current = request;
    setQuoteCreationRetrying(true);
    try {
      const next = await createRampQuote(endpoint, payload, request.signal, t);
      if (pending.current === request) {
        setCreated(next);
        setQuoteCreationError(null);
        onCreated?.(next.quote);
      }
    } catch (error) {
      if (pending.current === request) {
        setQuoteCreationError(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      if (pending.current === request) {
        pending.current = null;
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
    pending.current?.abort();
    pending.current = null;
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
