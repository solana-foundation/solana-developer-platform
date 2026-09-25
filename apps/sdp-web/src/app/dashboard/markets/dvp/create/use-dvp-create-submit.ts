"use client";

/**
 * Sending the create request.
 *
 * Separate from the form's state so the branching that decides WHAT to send
 * stays out of the code that decides whether it can be sent at all.
 */

import type { SolanaCluster } from "@sdp/types";
import { DVP_CREATE_REFUSAL, type DvpCreateRefusalReason } from "@sdp/types";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { DASHBOARD_MARKETS_SUBNAV_HREFS } from "@/lib/dashboard-navigation-loading";
import { IDEMPOTENCY_KEY_HEADER } from "@/lib/idempotency";
import { REVIEWED_PROJECT_HEADER_NAME } from "@/lib/project-cookie";
import { DVP_TOAST_POSITION, dvpToastAction } from "../dvp-action-toast";
import { freshDvpIdempotencyKey } from "../dvp-idempotency-key";
import { dvpErrorEnvelopeSchema } from "../dvp-trade";
import { TOKEN_2022_PROGRAM } from "./dvp-create.data";
import type { DvpPartyWire } from "./use-dvp-parties";

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

/** The created trade, as far as the confirmation needs it. */
const createdEnvelopeSchema = z.object({
  data: z.object({
    trade: z.object({ id: z.string().min(1), createSignature: z.string().nullable() }),
  }),
});

/** The proxy's refusal codes this form names in its own words. */
const createRefusalReasonSchema = z.enum(DVP_CREATE_REFUSAL);

/** The localized copy for each refusal the proxy can answer a create with. */
const CREATE_REFUSAL_COPY = {
  [DVP_CREATE_REFUSAL.reviewedProjectRequired]: "DashboardMarkets.dvp.projectReviewRequired",
  [DVP_CREATE_REFUSAL.reviewedProjectMismatch]: "DashboardMarkets.dvp.projectChangedSubmit",
} as const satisfies Record<DvpCreateRefusalReason, MessageKey>;

export function useDvpCreateSubmit(
  cluster: SolanaCluster,
  reviewedProjectId: string
): DvpCreateSubmit {
  const router = useRouter();
  const t = useTranslations();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per logical request. It rotates only once a trade was created, so
  // a second trade on the same terms is a new request rather than a replay of
  // the first. Every other outcome keeps it: a throw or a server error may have
  // left the first attempt broadcasting, and the retry has to replay it rather
  // than draw a second trade at a second address; a rejection stored nothing,
  // so the key is still free.
  //
  // The key is minted FOR the reviewed project and never leaves it: the ref
  // records which project the current key belongs to, and a changed project
  // mints a new one, so a key drawn under project A can never be presented
  // under sibling project B (APE-693).
  const idempotencyKey = useRef<{ key: string; project: string } | null>(null);
  // Minted on first use rather than as the ref's initial value, which would draw
  // (and throw away) fresh random bytes on every render.
  function currentIdempotencyKey(): string {
    const existing = idempotencyKey.current;
    if (existing !== null && existing.project === reviewedProjectId) {
      return existing.key;
    }
    const minted = { key: freshDvpIdempotencyKey("dvp-create"), project: reviewedProjectId };
    idempotencyKey.current = minted;
    return minted.key;
  }

  async function submit(request: DvpCreateRequest) {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/dashboard/markets/dvp/trades", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [IDEMPOTENCY_KEY_HEADER]: currentIdempotencyKey(),
          // The project whose terms this submit reviewed. The route refuses to
          // forward the create when the shared selection is no longer this.
          [REVIEWED_PROJECT_HEADER_NAME]: reviewedProjectId,
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
          tokenProgramA: request.tokenProgramA ?? TOKEN_2022_PROGRAM,
          tokenProgramB: request.tokenProgramB ?? TOKEN_2022_PROGRAM,
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

      // Status before body. A non-2xx response carries an error envelope, not
      // a trade, and reading it as one would navigate to `undefined`.
      if (!response.ok) {
        const failure = dvpErrorEnvelopeSchema.safeParse(await response.json().catch(() => null));
        if (!failure.success) {
          setError(t("DashboardMarkets.dvp.actionFailed", { status: String(response.status) }));
          return;
        }
        // A refusal the proxy named carries a code precisely so this form can
        // say it in the reader's language; anything else is relayed as sent.
        const reason = createRefusalReasonSchema.safeParse(failure.data.error.details?.reason);
        setError(reason.success ? t(CREATE_REFUSAL_COPY[reason.data]) : failure.data.error.message);
        return;
      }

      // A success answer that cannot be read says nothing about which trade
      // exists. The key is kept, so pressing Create again replays the trade the
      // first request made instead of drawing a second one.
      const created = createdEnvelopeSchema.safeParse(await response.json().catch(() => null));
      if (!created.success) {
        setError(t("DashboardMarkets.dvp.createUnconfirmed"));
        return;
      }
      // The next submit mints a new key: a second trade on the same terms is a new request.
      idempotencyKey.current = null;
      const { id: createdId, createSignature } = created.data.data.trade;
      // Confirmed before the navigation, so the trade page opens with the
      // reason it opened already stated. Creating publishes two escrow
      // addresses and costs rent; arriving on a new page with no acknowledgement
      // leaves somebody guessing whether they just did that twice.
      toast.success(t("DashboardMarkets.dvp.toastCreated"), {
        ...DVP_TOAST_POSITION,
        action: dvpToastAction(t, createSignature, cluster),
      });
      router.push(`${DASHBOARD_MARKETS_SUBNAV_HREFS.dvp}/${createdId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Create failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return { error, submit, submitting };
}
