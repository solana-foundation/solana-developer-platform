"use client";

import type { EarnVaultAsyncWithdrawalTermsRequest } from "@sdp/types/earn";
import { z } from "zod";
import type { MessageKey } from "@/i18n/messages";
import {
  createFloorMemo,
  createIdempotencyKeyStore,
  resetIdempotencyKeyStoresForTests,
} from "@/lib/idempotency-key-store";

export type EarnVaultAsyncWithdrawalIntent = {
  projectId: string | null;
  positionId: string;
  route:
    | {
        kind: "queue";
        discountBps: number;
        deadlineSeconds: number;
      }
    | {
        kind: "operator_redemption";
      };
} & (
  | {
      /** The customer's typed dollar amount; the request's shares are derived from it. */
      amount: string;
      intermediateAmount?: undefined;
    }
  /** A par request over the position's held intermediate: the typed quantity itself. */
  | { intermediateAmount: string; amount?: undefined }
);

/**
 * Durable per-tab keys for asynchronous custody exits. Keep the original
 * storage key so an in-flight request survives the product-level rename.
 */
export const vaultAsyncWithdrawalIdempotencyKeyStore = createIdempotencyKeyStore(
  "sdp:earn:vault-queued-withdrawal:idempotency:v1"
);

/**
 * Test-only: clear the shared module-scope tiers so specs are
 * order-independent. Production never calls this.
 *
 * @internal
 */
export function resetAsyncWithdrawalTrackingStateForTests(): void {
  resetIdempotencyKeyStoresForTests();
  vaultAsyncWithdrawalSharesMemo.resetForTests();
}

/**
 * What makes two submissions the SAME asynchronous request: the PROJECT, the
 * position, the user's TYPED quantity, and the queue's own discount and
 * deadline terms — every user-controlled field, including the asynchronous
 * route mechanism. Change any one and it is a different request, not a retry.
 *
 * The TYPED quantity is here in place of the share intent the API receives,
 * for the same reason the withdrawal fingerprint (PRO-1702) keeps it: the
 * fingerprint must be reproducible from user input while a key stays held.
 * Both share routes DERIVE their shares from the live position value, which
 * the positions polls re-read every few seconds — a fingerprint on the
 * derived shares drifts under a kept key, the retry misses it, mints a SECOND
 * key, and that submit can escrow again while the first attempt may already
 * be queued. The typed dollar amount is stable across every poll. The derived
 * shares the key actually went out with are remembered SEPARATELY
 * (`rememberAsyncWithdrawalShares`) and replayed verbatim, because the API's
 * own idempotency fingerprint includes `shares` and refuses a replay whose
 * body changed — exactly the refusal that retires the key and unlocks the
 * second escrow above.
 *
 * The held-intermediate route is the exception, on purpose: its request
 * redeems the position's `parIntermediate` in THAT token's own units, so its
 * typed input IS the wire quantity — nothing is derived, nothing drifts. Its
 * identity therefore keeps the previous build's shape (no tag, no memo), which
 * keeps every kept key that build minted reachable through `has` — renaming
 * its terms would orphan them, and there is no second shape to tell apart.
 *
 * Renaming the shares routes' fingerprint terms orphans the entries the
 * PREVIOUS build wrote under the same store key the same way: they are keyed
 * on the derived shares, so no fingerprint this build computes can ever find
 * them again, and a retry of such an attempt would mint a second key — the
 * double escrow above, one upgrade later. The shares identities therefore
 * LEAD with a format tag ({@link FINGERPRINT_FORMAT}), which makes the two
 * builds' entries tellable apart, and
 * {@link recallLegacyAsyncWithdrawalKeptKey} is the compatible recovery path:
 * the submit adopts the previous build's unresolved attempt and replays it
 * exactly instead of minting over it.
 */
export function vaultAsyncWithdrawalRequestFingerprint(
  input: EarnVaultAsyncWithdrawalIntent
): string {
  // A held-intermediate request carries its own marker, so it never shares a
  // key with a shares request for the same number; its identity is unchanged.
  if (input.intermediateAmount !== undefined) {
    return JSON.stringify([
      input.projectId,
      input.positionId,
      input.intermediateAmount,
      input.route.kind,
      "intermediate",
    ]);
  }
  const identity: (string | number | null)[] = [
    FINGERPRINT_FORMAT,
    input.projectId,
    input.positionId,
    input.amount,
    input.route.kind,
  ];
  if (input.route.kind === "queue") {
    identity.push(input.route.discountBps, input.route.deadlineSeconds);
  }
  return JSON.stringify(identity);
}

/**
 * The asynchronous fingerprint's FORMAT tag, leading every shares-route
 * identity this build writes. The previous build's identities lead with the
 * project instead — a `projectId` can never equal this tag, and the legacy
 * scan refuses any entry that does lead with it, so a kept key this build
 * minted under a different typed amount is never mistaken for a legacy one.
 */
const FINGERPRINT_FORMAT = "async-typed-quantity-1";

/**
 * One kept entry the PREVIOUS build wrote, parsed back out of its stored
 * fingerprint. The identity that build serialized was
 * `[projectId, positionId, shares, "queue", discountBps, deadlineSeconds]`
 * or `[projectId, positionId, shares, "operator_redemption"]` — the DERIVED
 * shares where this build keeps the typed dollar amount, no format tag — so
 * the identity itself carries the shares (and the queue's own terms) the
 * first attempt went out with, which is what makes an exact replay of that
 * attempt possible. The held-intermediate shape is parsed only to be SKIPPED:
 * its keys are still found through `has`, and adopting one from a shares
 * submission would replay the wrong request. Parsed by schema (saved input is
 * external input), never by hand; the three tuple shapes that build could
 * write collapse to one record.
 */
const legacyIdentitySchema = z.union([
  z
    .tuple([
      z.union([z.string(), z.null()]),
      z.string().min(1),
      z.string().min(1),
      z.literal("queue"),
      z.number(),
      z.number(),
    ])
    .transform(([projectId, positionId, shares, , discountBps, deadlineSeconds]) => ({
      intermediateAmount: undefined,
      projectId,
      positionId,
      route: { kind: "queue" as const, discountBps, deadlineSeconds },
      shares,
    })),
  z
    .tuple([
      z.union([z.string(), z.null()]),
      z.string().min(1),
      z.string().min(1),
      z.literal("operator_redemption"),
    ])
    .transform(([projectId, positionId, shares]) => ({
      intermediateAmount: undefined,
      projectId,
      positionId,
      route: { kind: "operator_redemption" as const },
      shares,
    })),
  z
    .tuple([
      z.union([z.string(), z.null()]),
      z.string().min(1),
      z.string().min(1),
      z.literal("operator_redemption"),
      z.literal("intermediate"),
    ])
    .transform(([projectId, positionId, intermediateAmount]) => ({
      intermediateAmount,
      projectId,
      positionId,
      route: { kind: "operator_redemption" as const },
      shares: undefined,
    })),
]);

/**
 * One kept entry the PREVIOUS build wrote, parsed back out of its stored
 * fingerprint. The identity that build serialized was
 * `[projectId, positionId, shares, "queue", discountBps, deadlineSeconds]`
 * or `[projectId, positionId, shares, "operator_redemption"]` — the DERIVED
 * shares where this build keeps the typed dollar amount, no format tag — so
 * the identity itself carries the shares (and the queue's own terms) the
 * first attempt went out with, which is what makes an exact replay of that
 * attempt possible. The held-intermediate shape is parsed only to be SKIPPED:
 * its keys are still found through `has`, and adopting one from a shares
 * submission would replay the wrong request. Parsed by schema (saved input is
 * external input), never by hand; the three tuple shapes that build could
 * write collapse to one record. Derived from the schema with `z.infer` —
 * the same fields are never maintained twice.
 */
type LegacyAsyncWithdrawalIdentity = z.infer<typeof legacyIdentitySchema>;

function legacyAsyncWithdrawalIdentity(
  fingerprint: string
): LegacyAsyncWithdrawalIdentity | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fingerprint);
  } catch {
    return undefined;
  }
  // This build's own entries lead with the format tag, which no legacy
  // identity could — the previous build led with the project. The tag check
  // runs before the schema so a this-build entry under a different typed
  // amount is refused even where its shape would parse.
  if (Array.isArray(parsed) && parsed[0] === FINGERPRINT_FORMAT) return undefined;
  const candidate = legacyIdentitySchema.safeParse(parsed);
  return candidate.success ? candidate.data : undefined;
}

/**
 * What adopting the previous build's unresolved attempt means concretely: the
 * key's legacy fingerprint, and the shares and route terms parsed out of that
 * identity — everything the replayed body needs, which is why a legacy
 * recovery is always exactly replayable and never depends on a memo.
 */
export type AsyncWithdrawalRecovery = {
  fingerprint: string;
  route:
    | { kind: "queue"; discountBps: number; deadlineSeconds: number }
    | { kind: "operator_redemption" };
  shares: string;
};

/**
 * The PREVIOUS build's unresolved attempt on this exit, if one is kept — the
 * upgrade bridge for the fingerprint change above. A kept entry is an attempt
 * that may already be escrowed and was never answered; submitting this exit
 * without adopting it would mint a second key and can escrow AGAIN. The
 * caller replays the adopted attempt's OWN request instead: its key (the
 * store answers `claim` under the legacy fingerprint) and its shares and
 * route terms (`asyncWithdrawalRecoveryBody` rebuilds that body). Whichever
 * way the API answers, it answers the FIRST attempt, and the answer retires
 * the legacy key.
 *
 * The adoption is a DECISION the caller surfaces for review before it sends —
 * the recovered shares are generally NOT the derivation the form is showing
 * (see the modals' recovery notice). The OLDEST match comes back first (see
 * `keptEntries`): several legacy attempts can be kept at once — a changed
 * discount or deadline minted a fresh key in the previous build too — and
 * each adopted replay resolves one, oldest first, until none is left and
 * typed-quantity keys flow normally. Only the project, position, and route
 * kind must match: the typed quantity cannot be compared across the two
 * builds (dollars against shares, at a rate neither recorded), and the queue
 * terms cannot either — the replay carries the legacy attempt's own terms,
 * whatever the form shows now. `undefined` when nothing legacy is kept.
 */
export function recallLegacyAsyncWithdrawalKeptKey(input: {
  projectId: string | null;
  positionId: string;
  routeKind: "queue" | "operator_redemption";
}): AsyncWithdrawalRecovery | undefined {
  for (const entry of vaultAsyncWithdrawalIdempotencyKeyStore.keptEntries()) {
    const legacy = legacyAsyncWithdrawalIdentity(entry.fingerprint);
    if (!legacy) continue;
    // A held-intermediate entry keeps the previous build's identity and its
    // own replayability — it is never adopted (see the type's comment).
    if (legacy.intermediateAmount !== undefined) continue;
    if (legacy.projectId !== input.projectId || legacy.positionId !== input.positionId) continue;
    if (legacy.route.kind !== input.routeKind) continue;
    return { fingerprint: entry.fingerprint, route: legacy.route, shares: legacy.shares };
  }
  return undefined;
}

/**
 * The wire body an ADOPTED legacy attempt replays: rebuilt field-by-field
 * from the identity the previous build serialized — its shares and its own
 * queue terms, never the live derivation or the form's current settings,
 * because the legacy key's first attempt carried exactly those and the API's
 * fingerprint refuses a changed body under a live key.
 */
export function asyncWithdrawalRecoveryBody(
  adopted: AsyncWithdrawalRecovery,
  positionId: string
): EarnVaultAsyncWithdrawalTermsRequest {
  return adopted.route.kind === "queue"
    ? {
        deadlineSeconds: adopted.route.deadlineSeconds,
        discountBps: adopted.route.discountBps,
        positionId,
        shares: adopted.shares,
      }
    : { mechanism: "operatorRedemption", positionId, shares: adopted.shares };
}

/**
 * Which kept key an asynchronous submission runs under, decided ONCE at
 * submit: the recovery the review surfaced (an ADOPTED previous-build attempt
 * — the submit then runs under the legacy fingerprint and replays that
 * attempt exactly, its own key and terms, so the API answers the first
 * attempt either way), or the typed-quantity fingerprint's own kept key.
 * `adopted` is set for an adoption only — the caller must send the adopted
 * body (`asyncWithdrawalRecoveryBody`) instead of any fresh derivation,
 * because the first attempt's body, verbatim, is the only request the legacy
 * key may carry.
 *
 * The adoption only stands while the recovered key is STILL kept. When it is
 * gone — its own answer arrived between the mount-time snapshot and this
 * confirm (a replay sent from a previous visit, retired late) — the
 * resolution is `spent` and resolves to NOTHING sendable: the
 * confirm was approved as a REPLAY of that attempt, so turning it into a
 * fresh typed submission would be the second escrow the adoption exists to
 * prevent. The caller stops, refreshes its recovery (the re-scan finds
 * nothing kept), and the next confirm — re-reviewed, notice gone — is a
 * normal typed-quantity submission.
 */
export type AsyncWithdrawalKeptKeyResolution =
  | { adopted: AsyncWithdrawalRecovery; fingerprint: string; kind: "adopted"; reused: true }
  /** This build's own typed-quantity fingerprint has a kept key. */
  | { fingerprint: string; kind: "kept"; reused: true }
  /** No key is kept; the next claim mints one. */
  | { fingerprint: string; kind: "fresh"; reused: false }
  /** The adopted attempt's own answer retired its key between mount and confirm. */
  | { fingerprint: string; kind: "spent"; recoverySpent: true; reused: true };

export function resolveAsyncWithdrawalKeptKey(input: {
  fingerprint: string;
  recovery?: AsyncWithdrawalRecovery | undefined;
}): AsyncWithdrawalKeptKeyResolution {
  const recovery = input.recovery;
  if (recovery) {
    if (!vaultAsyncWithdrawalIdempotencyKeyStore.has(recovery.fingerprint)) {
      return {
        fingerprint: recovery.fingerprint,
        kind: "spent",
        recoverySpent: true,
        reused: true,
      };
    }
    return { adopted: recovery, fingerprint: recovery.fingerprint, kind: "adopted", reused: true };
  }
  return vaultAsyncWithdrawalIdempotencyKeyStore.has(input.fingerprint)
    ? { fingerprint: input.fingerprint, kind: "kept", reused: true }
    : { fingerprint: input.fingerprint, kind: "fresh", reused: false };
}

/**
 * The saved request THIS build's kept key would replay, for the review step:
 * the share intent the key was MINTED with, read fresh each render from the
 * shares memo below. `undefined` when no key is kept; `shares` `undefined`
 * when the memo LOST it — the attempt cannot be replayed exactly and the
 * submit will send nothing (the review says so instead of a confirm that
 * could only double-escrow).
 */
export type KeptAsyncWithdrawalRetry = {
  /** The minted share intent, `undefined` when the shares memo lost it. */
  shares: string | undefined;
};

export function keptAsyncWithdrawalRetry(
  fingerprint: string | undefined
): KeptAsyncWithdrawalRetry | undefined {
  if (fingerprint === undefined) return undefined;
  if (!vaultAsyncWithdrawalIdempotencyKeyStore.has(fingerprint)) return undefined;
  return { shares: recallAsyncWithdrawalShares(fingerprint) };
}

/**
 * The share intent each kept fingerprint's key was MINTED with — the
 * withdrawal flows' shares memo, for the asynchronous exits. Both share
 * routes derive their intent from the live position value, so it cannot be
 * re-derived reliably when a kept key's retry comes back, and the API's
 * fingerprint pins `shares` anyway. The held-intermediate route never touches
 * this memo: its body IS its typed input.
 */
const vaultAsyncWithdrawalSharesMemo = createFloorMemo(
  "sdp:earn:vault-queued-withdrawal:shares:v1"
);

/** Record the share intent `fingerprint`'s key is being submitted with. */
export function rememberAsyncWithdrawalShares(fingerprint: string, shares: string): void {
  vaultAsyncWithdrawalSharesMemo.remember(fingerprint, shares);
}

/** The remembered share intent, or `undefined` when nothing is remembered. */
export function recallAsyncWithdrawalShares(fingerprint: string): string | undefined {
  return vaultAsyncWithdrawalSharesMemo.recall(fingerprint) ?? undefined;
}

/**
 * Drop a retired key's shares so the next fresh derivation cannot inherit it,
 * only once no key is kept for the fingerprint (see `forgetVaultDepositFloor`).
 */
export function forgetAsyncWithdrawalShares(fingerprint: string): void {
  if (vaultAsyncWithdrawalIdempotencyKeyStore.has(fingerprint)) return;
  vaultAsyncWithdrawalSharesMemo.forget(fingerprint);
}

/** Why a stopped asynchronous submit sent nothing (the copy keys are shared). */
export type AsyncWithdrawalSubmitStop = "recoverySpent" | "answered" | "sharesLost";

/** The review copy each stop raises — one copy for both asynchronous modals. */
export const ASYNC_WITHDRAWAL_STOP_COPY: Record<AsyncWithdrawalSubmitStop, MessageKey> = {
  answered: "DashboardEarn.vaultWithdraw.keptAsyncAttemptAnswered",
  recoverySpent: "DashboardEarn.vaultWithdraw.keptAsyncAttemptAnswered",
  sharesLost: "DashboardEarn.vaultWithdraw.keptAttemptRequestLost",
};

/** What one confirm on an asynchronous exit's review step sends, decided once. */
export type AsyncWithdrawalSubmitDecision =
  | {
      /** The send was an ADOPTED previous-build attempt: its answer spends the recovery. */
      adopted: boolean;
      kind: "send";
      /** The body is the typed held-intermediate input: no shares memo is kept for it. */
      intermediate: boolean;
      body: EarnVaultAsyncWithdrawalTermsRequest;
      fingerprint: string;
    }
  | { kind: "stop"; reason: AsyncWithdrawalSubmitStop };

/**
 * The kept-key decision BOTH asynchronous exit modals share (one copy on
 * purpose — two copies of a funds-protection rule is how one drifts): the
 * kept-key resolution, the share intent the request replays, and the wire
 * body built around it. Everything here resolves WITHOUT yielding so the
 * caller can claim the key in the same synchronous block — THE REPLAY PATH
 * MUST NOT YIELD (see `resolveSubmitIntent` in the instant exit modal): a
 * kept key's confirm is a promise to resubmit THAT attempt, and an await in
 * between is a gap in which the first attempt's late answer can retire the
 * key — the claim would then mint a second one and the API would see a
 * second escrow.
 *
 * A `stop` sends NOTHING and the caller raises its copy
 * ({@link ASYNC_WITHDRAWAL_STOP_COPY}): a `recoverySpent` stop also re-scans
 * (that confirm was approved as a replay of an attempt whose answer arrived
 * in the meantime — never a fresh escrow over it), an `answered` stop ends a
 * review whose saved request was retired between the render and the confirm,
 * and a `sharesLost` stop refuses to pair a kept key with a changed request.
 *
 * A `send` carries the body to POST under `fingerprint`'s key: an ADOPTED
 * legacy attempt replays its OWN body (`asyncWithdrawalRecoveryBody`), a kept
 * key replays the share intent its key was MINTED with (the memo), and a
 * fresh key sends the live derivation verbatim. The held-intermediate route
 * needs none of the kept-key machinery: its body IS its typed input — the
 * fingerprint's own quantity — so even a kept key replays it verbatim with no
 * memo and no adoption (the recovery scan never runs for it).
 */
export function decideAsyncWithdrawalSubmit(input: {
  approvedTerms: KeptAsyncWithdrawalRetry | undefined;
  freshBody: EarnVaultAsyncWithdrawalTermsRequest;
  fingerprint: string;
  recovery?: AsyncWithdrawalRecovery | undefined;
}): AsyncWithdrawalSubmitDecision {
  const resolution = resolveAsyncWithdrawalKeptKey({
    fingerprint: input.fingerprint,
    recovery: input.recovery,
  });
  if (resolution.kind === "spent") return { kind: "stop", reason: "recoverySpent" };
  // The confirm was approved against the review AS RENDERED: when it showed
  // a saved request (`approvedTerms`), it promised to resubmit THAT attempt —
  // never a fresh escrow over it. A key retired between the review and this
  // confirm (the first attempt's late answer lands) resolves `reused: false`
  // here, and minting under the typed quantity then would be exactly the
  // second escrow the notice promised not to do. The error re-render reads
  // the memo fresh, so the notice is gone and the next confirm is
  // re-reviewed against current terms.
  if (input.approvedTerms && !resolution.reused) return { kind: "stop", reason: "answered" };

  const freshBody = input.freshBody;
  if (freshBody.mechanism === "operatorRedemption" && freshBody.intermediateAmount !== undefined) {
    return {
      adopted: false,
      body: freshBody,
      fingerprint: resolution.fingerprint,
      intermediate: true,
      kind: "send",
    };
  }
  // A KEPT key — one an earlier attempt left unretired (a lost answer, a 5xx,
  // a refusal that settled nothing) — must replay the request it was MINTED
  // with, verbatim: the API's own idempotency fingerprint includes the share
  // intent, and a changed body under the key is a 422, which retires the key
  // and lets the next submit mint a fresh one while the first attempt may
  // already be escrowed. The shares memo answers for it (the fingerprint keys
  // on the typed dollar amount, so the kept key is found even though the live
  // derivation has moved). An ADOPTED legacy key's shares and queue terms
  // came out of the legacy fingerprint itself. A fresh key sends the live
  // derivation.
  let shares: string | undefined;
  switch (resolution.kind) {
    case "adopted":
      shares = resolution.adopted.shares;
      break;
    case "kept":
      shares = recallAsyncWithdrawalShares(resolution.fingerprint);
      break;
    case "fresh":
      shares = freshBody.shares;
      break;
    default: {
      const exhaustive: never = resolution;
      throw new Error(`Unhandled kept-key resolution: ${JSON.stringify(exhaustive)}`);
    }
  }
  if (shares === undefined) return { kind: "stop", reason: "sharesLost" };
  rememberAsyncWithdrawalShares(resolution.fingerprint, shares);
  // Rebuilt from the DECIDED share intent, never the fresh body whole: on a
  // kept key the fresh derivation has moved and the minted shares are what
  // the API's fingerprint pins.
  let body: EarnVaultAsyncWithdrawalTermsRequest;
  switch (resolution.kind) {
    case "adopted":
      body = asyncWithdrawalRecoveryBody(resolution.adopted, freshBody.positionId);
      break;
    case "kept":
    case "fresh":
      body = typedAsyncWithdrawalBody(freshBody, shares);
      break;
    default: {
      const exhaustive: never = resolution;
      throw new Error(`Unhandled kept-key resolution: ${JSON.stringify(exhaustive)}`);
    }
  }
  return {
    adopted: resolution.kind === "adopted",
    body,
    fingerprint: resolution.fingerprint,
    intermediate: false,
    kind: "send",
  };
}

/**
 * The body a TYPED submission sends (a kept key's replay and a fresh send
 * alike): the live derivation's own terms around the DECIDED share intent.
 */
function typedAsyncWithdrawalBody(
  freshBody: EarnVaultAsyncWithdrawalTermsRequest,
  shares: string
): EarnVaultAsyncWithdrawalTermsRequest {
  return freshBody.mechanism === "operatorRedemption"
    ? { mechanism: "operatorRedemption", positionId: freshBody.positionId, shares }
    : {
        deadlineSeconds: freshBody.deadlineSeconds,
        discountBps: freshBody.discountBps,
        positionId: freshBody.positionId,
        shares,
      };
}
