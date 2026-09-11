"use client";

/**
 * Sending the create request.
 *
 * Separate from the form's state so the branching that decides WHAT to send
 * stays out of the code that decides whether it can be sent at all.
 */

import { SPL_TOKEN_PROGRAMS } from "@sdp/types";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "@/i18n/provider";
import { DASHBOARD_MARKETS_SUBNAV_HREFS } from "@/lib/dashboard-navigation-loading";
import type { DvpPartyWire } from "./use-dvp-parties";

const TOKEN_2022 = SPL_TOKEN_PROGRAMS["token-2022"];

/**
 * A fresh idempotency key, from `getRandomValues` rather than `randomUUID`:
 * the latter needs a secure context, and a dashboard reached over plain http
 * on a LAN address has none.
 */
function freshIdempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `dvp-create-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export interface DvpCreateRequest {
  parties: { a: DvpPartyWire; b: DvpPartyWire };
  amountA: string;
  amountB: string;
  /** The expiry as a local wall-clock datetime, "YYYY-MM-DDTHH:mm". */
  expiry: string;
  mintA: string;
  mintB: string;
  refString: string;
  /** Each listed mint carries its own program; a pasted one is assumed T22. */
  tokenProgramA: string | null;
  tokenProgramB: string | null;
  /**
   * Where each party's proceeds go. Empty means the party's own address, which
   * is what the program records for an omitted destination.
   */
  userASettlementDestination: string;
  userBSettlementDestination: string;
}

export interface DvpCreateSubmit {
  error: string | null;
  submit: (request: DvpCreateRequest) => Promise<void>;
  submitting: boolean;
}

export function useDvpCreateSubmit(): DvpCreateSubmit {
  const router = useRouter();
  const t = useTranslations();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per logical request. It survives a throw (a dropped connection, a
  // timeout) so the retry replays instead of drawing a second trade at a second
  // address, and rotates once any response arrives, so a second trade on the
  // same terms is a new request rather than a replay of the first.
  const idempotencyKey = useRef(freshIdempotencyKey());

  async function submit(request: DvpCreateRequest) {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/dashboard/markets/dvp/trades", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey.current,
        },
        body: JSON.stringify({
          partyA: request.parties.a.ref,
          partyB: request.parties.b.ref,
          mintA: request.mintA,
          mintB: request.mintB,
          // A PASTED address is assumed Token-2022; if it is not, create
          // refuses and names the mismatch rather than publishing an escrow
          // derived under the wrong program, which is the failure the form
          // cannot detect itself.
          tokenProgramA: request.tokenProgramA ?? TOKEN_2022,
          tokenProgramB: request.tokenProgramB ?? TOKEN_2022,
          amountA: request.amountA,
          amountB: request.amountB,
          // Local wall clock, deliberately: the person picked a time off
          // their own clock, so the deadline lands at that local moment.
          expiryTimestamp: String(Math.floor(new Date(`${request.expiry}:59`).getTime() / 1000)),
          ...(request.refString ? { refString: request.refString } : {}),
          // Omitted rather than sent empty. The API reads absent as "the
          // party's own address"; an empty string would fail the address
          // pattern and 400 an otherwise ordinary trade.
          ...(request.userASettlementDestination
            ? { userASettlementDestination: request.userASettlementDestination }
            : {}),
          ...(request.userBSettlementDestination
            ? { userBSettlementDestination: request.userBSettlementDestination }
            : {}),
        }),
      });

      idempotencyKey.current = freshIdempotencyKey();

      // Status before body. A non-2xx response carries an error envelope, not
      // a trade, and reading it as one would navigate to `undefined`.
      if (!response.ok) {
        const failure = (await response.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        setError(failure.error?.message ?? `Create failed (${response.status}).`);
        return;
      }

      const body = (await response.json().catch(() => ({}))) as {
        data?: { trade?: { id?: string } };
      };
      const id = body.data?.trade?.id;
      // Confirmed before the navigation, so the trade page opens with the
      // reason it opened already stated. Creating publishes two escrow
      // addresses and costs rent; arriving on a new page with no acknowledgement
      // leaves somebody guessing whether they just did that twice.
      toast.success(t("DashboardMarkets.dvp.toastCreated"), { position: "bottom-right" });
      router.push(
        id ? `${DASHBOARD_MARKETS_SUBNAV_HREFS.dvp}/${id}` : DASHBOARD_MARKETS_SUBNAV_HREFS.dvp
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Create failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return { error, submit, submitting };
}
