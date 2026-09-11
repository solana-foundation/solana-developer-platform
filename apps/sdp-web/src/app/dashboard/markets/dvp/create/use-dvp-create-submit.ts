"use client";

/**
 * Sending the create request.
 *
 * Separate from the form's state so the branching that decides WHAT to send
 * stays out of the code that decides whether it can be sent at all.
 */

import { SPL_TOKEN_PROGRAMS, WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { useOptionalDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { DASHBOARD_MARKETS_SUBNAV_HREFS } from "@/lib/dashboard-navigation-loading";
import { useMarketsSandbox } from "../../markets-sandbox-store";
import type { DvpPartyRef as DvpDisplayPartyRef, DvpTrade, DvpTradeLeg } from "../dvp-trade";
import type { DvpPartyRef, DvpPartyWire } from "./use-dvp-parties";

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

/** Which reference kind named a party, for the fingerprint. */
function partyRefKind(ref: DvpPartyRef): string {
  if ("walletId" in ref) {
    return "walletId";
  }
  if ("counterpartyAccountId" in ref) {
    return "counterpartyAccountId";
  }
  return "address";
}

function createIdempotencyKey(request: DvpCreateRequest): string {
  const material = JSON.stringify([
    // The party's address plus which reference kind named it: a wallet and a
    // registered counterparty resolving to the same address are different
    // attributions, and the fingerprint treats them as different parties.
    `${partyRefKind(request.parties.a.ref)}:${request.parties.a.address}`,
    `${partyRefKind(request.parties.b.ref)}:${request.parties.b.address}`,
    request.mintA,
    request.tokenProgramA ?? TOKEN_2022,
    request.mintB,
    request.tokenProgramB ?? TOKEN_2022,
    request.amountA,
    request.amountB,
    request.expiry,
    request.refString,
    // Must stay in step with the server fingerprint, which gained these at the
    // same time. Two trades identical but for where the proceeds go are
    // different trades; leaving these out would give them one key and get the
    // second refused as a mismatched replay.
    request.userASettlementDestination,
    request.userBSettlementDestination,
  ]);

  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(material)) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & FNV_MASK;
  }
  return `dvp-create-${hash.toString(16).padStart(32, "0")}`;
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
  const workspace = useOptionalDashboardWorkspace();
  const { saveDvpTrade } = useMarketsSandbox(workspace?.selectedProjectId ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(request: DvpCreateRequest) {
    setSubmitting(true);
    setError(null);
    try {
      if (workspace?.sdpEnvironment === "sandbox") {
        const trade = buildSandboxTrade(request, {
          walletName: t("DashboardMarkets.sandbox.dvpWalletName"),
          counterpartyLabel: t("DashboardMarkets.sandbox.dvpCounterpartyName"),
        });
        saveDvpTrade(trade);
        toast.success(t("DashboardMarkets.dvp.toastCreated"), { position: "bottom-right" });
        router.push(`${DASHBOARD_MARKETS_SUBNAV_HREFS.dvp}/${trade.id}`);
        return;
      }
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

interface SandboxDvpLabels {
  walletName: string;
  counterpartyLabel: string;
}

function sandboxParty(party: DvpPartyWire, labels: SandboxDvpLabels): DvpDisplayPartyRef {
  if ("walletId" in party.ref) {
    return {
      address: party.address,
      counterparty: null,
      wallet: { id: party.ref.walletId, name: labels.walletName },
    };
  }
  if ("counterpartyAccountId" in party.ref) {
    return {
      address: party.address,
      counterparty: { id: party.ref.counterpartyAccountId, label: labels.counterpartyLabel },
      wallet: null,
    };
  }
  return { address: party.address, counterparty: null, wallet: null };
}

function sandboxLeg(
  input: {
    amount: string;
    mint: string;
    party: DvpPartyWire;
    tokenProgram: string | null;
    escrow: string;
    settlementDestination: string;
  },
  labels: SandboxDvpLabels
): DvpTradeLeg {
  const token = WELL_KNOWN_TOKEN_BY_MINT.get(input.mint);
  return {
    party: sandboxParty(input.party, labels),
    mint: input.mint,
    tokenProgram: input.tokenProgram ?? TOKEN_2022,
    decimals: token?.decimals ?? null,
    symbol: token?.symbol ?? null,
    imageUrl: null,
    amount: input.amount,
    escrow: input.escrow,
    settlementDestination: input.settlementDestination || input.party.address,
    funding: null,
    fundingSignature: null,
    outcome: "awaiting",
  };
}

function buildSandboxTrade(request: DvpCreateRequest, labels: SandboxDvpLabels): DvpTrade {
  const now = new Date().toISOString();
  const id = `dvp_local_${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
  const custodiedSides = [request.parties.a, request.parties.b].filter(
    (party) => "walletId" in party.ref
  ).length;
  return {
    id,
    status: "created",
    kind: custodiedSides === 2 ? "bilateral" : custodiedSides === 1 ? "principal" : "agent",
    swapDvp: "BXvugAaWDqgADmGTdwgdzVZUyJbagNM6w4hPrC4JQ1po",
    settlementAuthority: "9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY",
    legs: {
      a: sandboxLeg(
        {
          amount: request.amountA,
          mint: request.mintA,
          party: request.parties.a,
          tokenProgram: request.tokenProgramA,
          escrow: "FwQyjVB3o9UkWEEWZVLbvc3EizH3jhHp4g9HmpmuzGWU",
          settlementDestination: request.userASettlementDestination,
        },
        labels
      ),
      b: sandboxLeg(
        {
          amount: request.amountB,
          mint: request.mintB,
          party: request.parties.b,
          tokenProgram: request.tokenProgramB,
          escrow: "6yDKQfAMjjnQCgkHJvpDc1CVPx2vPDLhDkhZYQPw7w9y",
          settlementDestination: request.userBSettlementDestination,
        },
        labels
      ),
    },
    nonce: String(Date.now()),
    expiryTimestamp: String(Math.floor(new Date(`${request.expiry}:59`).getTime() / 1000)),
    earliestSettlementTimestamp: null,
    refString: request.refString || null,
    createSignature: null,
    closeSignature: null,
    settlementReadiness: {
      address: "9BvXsTHgFvS31NLpVN4hpAoHCTfwvVX1XkgFq7fJEZxY",
      balance: "1000000000000",
      required: "0",
      funded: true,
    },
    observedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}
