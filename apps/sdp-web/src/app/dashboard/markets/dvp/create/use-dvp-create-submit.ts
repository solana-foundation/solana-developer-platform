"use client";

/**
 * Sending the create request.
 *
 * Separate from the form's state so the branching that decides WHAT to send
 * stays out of the code that decides whether it can be sent at all.
 */

import { SPL_TOKEN_PROGRAMS } from "@sdp/types";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DASHBOARD_MARKETS_SUBNAV_HREFS } from "@/lib/dashboard-navigation-loading";

const TOKEN_2022 = SPL_TOKEN_PROGRAMS["token-2022"];

/**
 * The idempotency key for one logical create.
 *
 * Derived from the WHOLE payload, in the same field order the API fingerprints
 * (`apps/sdp-api/src/services/dvp/fingerprint.ts`). That order is not cosmetic:
 * the API compares a replay's fingerprint against the stored one and refuses a
 * mismatch, so a key covering fewer fields than the fingerprint turns two
 * genuinely different trades into "Idempotency key already used with different
 * request payload". Same wallet, counterparty, amounts and expiry but a
 * different mint is the case that reached a 409 — a valid trade, refused.
 *
 * Hashed rather than concatenated only to keep the header short; every field
 * that distinguishes one trade from another is inside the digest, which is what
 * makes a double submit a replay and a changed asset a new request.
 *
 * Deliberately NOT `crypto.subtle`. That is async and, more importantly, only
 * exists in a secure context — a dashboard reached over plain http on a LAN
 * address would have no `subtle` at all and every create would throw. Nothing
 * else in this app depends on it, and an idempotency key needs to be
 * deterministic, not unforgeable: the API re-derives its own SHA-256
 * fingerprint server-side and refuses a mismatched replay, so this value is a
 * lookup handle rather than a security boundary.
 *
 * 128-bit FNV-1a over the JSON encoding. JSON is what makes the input
 * injective: a `refString` is free text and could otherwise contain whatever
 * separator a plain join picked, letting two different trades produce one key.
 */
const FNV_OFFSET = 0x6c62272e07bb014262b821756295c58dn;
const FNV_PRIME = 0x0000000001000000000000000000013bn;
const FNV_MASK = (1n << 128n) - 1n;

function createIdempotencyKey(request: DvpCreateRequest): string {
  const material = JSON.stringify([
    request.walletId,
    request.sdpSide,
    request.counterparty,
    request.mintA,
    request.tokenProgramA ?? TOKEN_2022,
    request.mintB,
    request.tokenProgramB ?? TOKEN_2022,
    request.amountA,
    request.amountB,
    request.expiry,
    request.refString,
  ]);

  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(material)) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & FNV_MASK;
  }
  return `dvp-create-${hash.toString(16).padStart(32, "0")}`;
}

export interface DvpCreateRequest {
  amountA: string;
  amountB: string;
  counterparty: string;
  expiry: string;
  mintA: string;
  mintB: string;
  refString: string;
  sdpSide: "a" | "b";
  /** Each listed mint carries its own program; a pasted one is assumed T22. */
  tokenProgramA: string | null;
  tokenProgramB: string | null;
  walletId: string;
}

export interface DvpCreateSubmit {
  error: string | null;
  submit: (request: DvpCreateRequest) => Promise<void>;
  submitting: boolean;
}

export function useDvpCreateSubmit(): DvpCreateSubmit {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(request: DvpCreateRequest) {
    setSubmitting(true);
    setError(null);
    try {
      // One logical request: a double submit, or a retry after a dropped
      // connection, must not create a second trade at a second address.
      const idempotencyKey = createIdempotencyKey(request);
      const response = await fetch("/api/dashboard/markets/dvp/trades", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          sdpWalletId: request.walletId,
          sdpSide: request.sdpSide,
          counterparty: request.counterparty,
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
          expiryTimestamp: String(
            Math.floor(new Date(`${request.expiry}T23:59:59Z`).getTime() / 1000)
          ),
          ...(request.refString ? { refString: request.refString } : {}),
        }),
      });

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
