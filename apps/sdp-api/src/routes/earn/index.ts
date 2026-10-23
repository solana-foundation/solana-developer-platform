import { type Context, Hono, type Next } from "hono";
import { AppError } from "@/lib/errors";
import { isEarnEnabled } from "@/lib/feature-flags";
import { unifiedAuthMiddleware } from "@/middleware/auth";
import { meteredQuota } from "@/middleware/metered-quota";
import { projectContextMiddleware } from "@/middleware/project-context";
import { requestGate } from "@/middleware/request-gate";
import { requireAction } from "@/middleware/require-action";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import { isEarnExitOrRead } from "./exits";
import {
  createEarnExternalWalletDeposit,
  createEarnExternalWalletDepositTransaction,
  createEarnExternalWalletWithdrawal,
  createEarnExternalWalletWithdrawalPreview,
  createEarnExternalWalletWithdrawalTransaction,
  getEarnExternalWalletEarnings,
  getEarnExternalWalletMovement,
  getEarnExternalWalletPositionSummary,
  listEarnExternalWalletMovements,
  listEarnExternalWalletPositions,
} from "./handlers/external-wallet";
import { listEarnMovements } from "./handlers/movements";
import {
  createEarnProgram,
  createEarnProgramWithdrawal,
  extractEarnProgramWithdrawal,
  getEarnProgram,
  getEarnProgramWithdrawal,
  listEarnProgramDeposits,
  listEarnPrograms,
  listEarnProgramWithdrawals,
  previewEarnProgramWithdrawal,
  retargetEarnProgram,
} from "./handlers/program";
import {
  cancelEarnVaultWithdrawalRequest,
  createEarnExternalWalletQueuedWithdrawalPreview,
  createEarnExternalWalletWithdrawalRequest,
  createEarnExternalWalletWithdrawalRequestCancellation,
  createEarnExternalWalletWithdrawalRequestCancelTransaction,
  createEarnExternalWalletWithdrawalRequestTransaction,
  createEarnVaultQueuedWithdrawalPreview,
  createEarnVaultWithdrawalRequest,
  extractEarnVaultWithdrawalRequest,
  findEarnVaultWithdrawalRequestIdempotentKeyReplay,
  getEarnExternalWalletWithdrawalOptions,
  getEarnExternalWalletWithdrawalRequest,
  getEarnVaultWithdrawalOptions,
  getEarnVaultWithdrawalRequest,
  listEarnExternalWalletWithdrawalRequests,
  listEarnVaultWithdrawalRequests,
} from "./handlers/queued-withdrawals";
import { getEarnStrategy, listEarnStrategies } from "./handlers/strategies";
import {
  admitEarnVaultDeposit,
  admitEarnVaultRuntimeExecution,
  assertEarnVaultWithdrawalFloor,
  createEarnVaultDeposit,
  createEarnVaultDepositPreview,
  createEarnVaultWithdrawal,
  createEarnVaultWithdrawalPreview,
  extractEarnVaultDeposit,
  extractEarnVaultWithdrawal,
  findEarnVaultDepositIdempotentKeyReplay,
  findEarnVaultWithdrawalIdempotentKeyReplay,
  getEarnVaultDeposit,
  getEarnVaultWithdrawal,
  listEarnVaultDeposits,
  listEarnVaultPositions,
  listEarnVaultWithdrawals,
} from "./handlers/vault";
import { getEarnVaultShareReconciliation } from "./handlers/vault-reconciliation";
import {
  earnExternalWalletDepositTransactionSchema,
  earnExternalWalletQueuedWithdrawalPreviewSchema,
  earnExternalWalletSubmitSchema,
  earnExternalWalletWithdrawalOptionsSchema,
  earnExternalWalletWithdrawalPreviewSchema,
  earnExternalWalletWithdrawalRequestCancelTransactionSchema,
  earnExternalWalletWithdrawalRequestTransactionSchema,
  earnExternalWalletWithdrawalTransactionSchema,
  earnProgramCreateSchema,
  earnProgramRetargetSchema,
  earnProgramWithdrawalCreateSchema,
  earnProgramWithdrawalPreviewSchema,
  earnVaultDepositPreviewSchema,
  earnVaultDepositSchema,
  earnVaultQueuedWithdrawalPreviewSchema,
  earnVaultWithdrawalOptionsSchema,
  earnVaultWithdrawalPreviewSchema,
  earnVaultWithdrawalRequestCancelSchema,
  earnVaultWithdrawalRequestSchema,
  earnVaultWithdrawalSchema,
} from "./schemas";

export const earnRoutes = new Hono<{ Bindings: Env }>();
const earn = new Hono<{ Bindings: Env }>();

// Gate the whole family behind the Earn feature flag until it is ready for
// prime time. Off by default; enable per-environment with EARN_ENABLED plus its
// parent MARKETS_ENABLED — isEarnEnabled owns that hierarchy, so no separate
// markets check belongs here.
async function requireEarnFeature(c: Context<{ Bindings: Env }>, next: Next) {
  if (!isEarnEnabled(c.env)) {
    throw new AppError("FORBIDDEN", "Earn is not enabled for this environment");
  }
  await next();
}

earnRoutes.use("*", requireEarnFeature);

const earnProjectContextOptions = {
  allowUnentitledProduction: (c: Context<{ Bindings: Env }>) =>
    isEarnExitOrRead(c.req.method, c.req.path),
};

const EARN_CATALOGUE_CACHE_CONTROL = "private, max-age=30";
async function cacheEarnCatalogue(c: Context<{ Bindings: Env }>, next: Next) {
  await next();
  if (c.res.status >= 200 && c.res.status < 300) {
    c.header("Cache-Control", EARN_CATALOGUE_CACHE_CONTROL);
  }
}

const EARN_PROVIDER_READ_QUOTA = {
  name: "earn-provider-read",
  actorMax: 60,
  orgMax: 240,
} as const;
const EARN_CHAIN_READ_QUOTA = { name: "earn-chain-read", actorMax: 30, orgMax: 120 } as const;

// Every Earn route requires a credential and runs in the caller's project.
// A request with none gets the API-facing 401 before projectContextMiddleware
// can turn a missing project into a 400.
async function requireKeyedEarnCredential(c: Context<{ Bindings: Env }>, next: Next) {
  if (!c.req.header("Authorization")) {
    throw new AppError("UNAUTHORIZED", "API key required for this Earn route");
  }
  await next();
}

earn.use("*", requireKeyedEarnCredential);
earn.use("*", unifiedAuthMiddleware());
earn.use("*", projectContextMiddleware(earnProjectContextOptions));

// Metered quotas for the Earn reads that fan out to a PAID upstream — the
// provider's API on a program read, Solana RPC on a live-hydrated one. A single
// `GET /programs` page is 2N provider round trips against a shared account, so
// an unmetered caller spends the platform's money at whatever rate it likes.
//
// What is deliberately NOT metered is every money-OUT route and every EXIT
// quote: withdrawals, vault withdrawals, the external-wallet submits, the
// external-wallet exit build, and the previews an exit derives its floor from.
// `meteredQuota` FAILS CLOSED — a counter-store outage answers 503 — and a 5xx
// on a customer's way out of a position is precisely the failure ADR 0002 exit
// safety rules out. A refused read costs a caller a retry; a refused exit traps
// funds. A fail-OPEN meter on the exit routes was weighed and dropped
// (PRO-1994): a 429 is still a refusal on the way out, so keyed exit traffic
// is bounded by the general per-key tier alone, as accepted risk.
//
// Money-IN carries no such rule, so the deposit quote and the external-wallet
// deposit build are metered.
// Strategy catalogue (source: DB, admitted only by the sync cron), read in
// the caller's project environment.
earn.get("/strategies", requireAction("earn.read"), cacheEarnCatalogue, listEarnStrategies);
earn.get(
  "/strategies/:strategyId",
  requireAction("earn.read"),
  cacheEarnCatalogue,
  getEarnStrategy
);

// The deposit QUOTE is money-IN shaped, so it is metered. The body is validated
// BEFORE the meter: the counter is shared by the whole organization, so a
// malformed request must not spend the pool that later valid quotes and builds
// draw from.
earn.post(
  "/vault-deposit-previews",
  requireAction("earn.read"),
  validateBody(earnVaultDepositPreviewSchema),
  meteredQuota(EARN_PROVIDER_READ_QUOTA),
  createEarnVaultDepositPreview
);

// B2B2C live holdings (PRO-1724). The owner is a REQUIRED query filter on
// every per-owner read of this surface (positions, movements, earnings) — one
// addressing style for one concept, and no literal segment (`summary`) can
// ever be captured as a Solana address. `earn.read` only: these are end-user
// wallets SDP does not custody, so no wallet scope applies.
earn.get(
  "/external-wallet/positions/summary",
  requireAction("earn.read"),
  meteredQuota(EARN_CHAIN_READ_QUOTA),
  getEarnExternalWalletPositionSummary
);
earn.get(
  "/external-wallet/positions",
  requireAction("earn.read"),
  meteredQuota(EARN_CHAIN_READ_QUOTA),
  listEarnExternalWalletPositions
);

// B2B2C activity and earnings (PRO-1772): the reads that close the loop the
// money routes below open. Same posture as the position reads — `earn.read`
// only (end-user wallets are outside any wallet scope), and NO provider gate:
// these report on money that already moved (ADR 0002). The
// movements collection is declared before its `:movementId` detail so a
// literal segment can never be captured as an id.
earn.get("/external-wallet/movements", requireAction("earn.read"), listEarnExternalWalletMovements);
earn.get(
  "/external-wallet/movements/:movementId",
  requireAction("earn.read"),
  getEarnExternalWalletMovement
);
earn.get(
  "/external-wallet/earnings",
  requireAction("earn.read"),
  meteredQuota(EARN_CHAIN_READ_QUOTA),
  getEarnExternalWalletEarnings
);
earn.post(
  "/external-wallet/withdrawal-request-transactions",
  requireAction("earn.execute"),
  validateBody(earnExternalWalletWithdrawalRequestTransactionSchema),
  createEarnExternalWalletWithdrawalRequestTransaction
);
earn.post(
  "/external-wallet/withdrawal-request-cancel-transactions",
  requireAction("earn.manage"),
  validateBody(earnExternalWalletWithdrawalRequestCancelTransactionSchema),
  createEarnExternalWalletWithdrawalRequestCancelTransaction
);
earn.get(
  "/external-wallet/withdrawal-requests",
  requireAction("earn.read"),
  listEarnExternalWalletWithdrawalRequests
);
earn.get(
  "/external-wallet/withdrawal-requests/:withdrawalRequestId",
  requireAction("earn.read"),
  getEarnExternalWalletWithdrawalRequest
);

// Non-custodial ("vault_direct") positions: SDP builds and signs the deposit
// from a custody wallet, so unlike /programs there is no provider wallet to
// provision and no address to fund afterwards.
//
// Each route declares one action; whether the caller may sign with the named
// custody wallet is the custody signer's decision, deposit and withdrawal
// alike (HOO-2099, ADR 0007 addendum).
//
// `requestGate` resolves the strategy and wallet and answers an
// Idempotency-Key replay before the handler runs. The route reaches
// `createOrgSignerForCustodyWallet` and broadcasts a value-moving transaction,
// so the gate must sit AFTER `requireAction` and `validateBody`, and immediately before the handler, so a refusal is
// decided before any KMS or relay access.
earn.post(
  "/vault-deposits",
  requireAction("earn.execute"),
  validateBody(earnVaultDepositSchema),
  requestGate({
    extract: extractEarnVaultDeposit,
    findIdempotentKeyReplay: findEarnVaultDepositIdempotentKeyReplay,
    // The money-in gates run AFTER the completed-replay exit so a recorded
    // deposit stays replayable when its strategy pauses or a policy flips.
    admit: async (c, extraction) => {
      await admitEarnVaultDeposit(c, extraction);
      await admitEarnVaultRuntimeExecution(c, extraction);
    },
  }),
  createEarnVaultDeposit
);
// The deposit READS take no request gate and no provider gate — they move no
// money and report on money that already left the wallet. They are what makes a
// signed-but-unconfirmed deposit answerable: `POST` records before broadcast,
// so a caller can hold a movement id for a transaction whose outcome it never
// saw, and the every-minute reconciliation sweep is what eventually settles it.
//
// The collection is declared BEFORE the `:movementId` route, the same ordering
// rule `/programs` follows, so a literal segment can never be captured as an id.
// `?requestId=` on the collection finds a deposit by the caller's
// Idempotency-Key when the original response was lost.
earn.get("/vault-deposits", requireAction("earn.read"), listEarnVaultDeposits);
earn.get("/vault-deposits/:movementId", requireAction("earn.read"), getEarnVaultDeposit);
// The EXIT half (PRO-1702): redeem a position's shares back to the custody
// wallet that holds them. Request-gated for the same reason the deposit is —
// it reaches `createOrgSignerForCustodyWallet` and broadcasts value-moving
// transactions. Beyond it this route takes only the capability answer (501 when the
// provider cannot build an exit): ADR 0002 exit safety forbids money-out
// inheriting surfacing, entitlement, availability, environment capability, or
// any catalogue dependency — the position row names the instrument, so a
// delisted vault stays exitable.
earn.post(
  "/vault-withdrawals",
  requireAction("earn.execute"),
  validateBody(earnVaultWithdrawalSchema),
  requestGate({
    extract: extractEarnVaultWithdrawal,
    findIdempotentKeyReplay: findEarnVaultWithdrawalIdempotentKeyReplay,
    // The floor check runs AFTER the completed-replay exit so a recorded
    // floor-less withdrawal stays replayable if the provider's policy flips.
    admit: async (c, extraction) => {
      await assertEarnVaultWithdrawalFloor(c, extraction);
      await admitEarnVaultRuntimeExecution(c, extraction);
    },
  }),
  createEarnVaultWithdrawal
);
// The exit QUOTE: a read with EXIT gates only — position scoping (404),
// capability (501), and deliberately nothing money-in-shaped (ADR 0002 exit
// safety): no surfacing, no entitlement, no admission, no environment
// capability. Project-scoped like the position reads (HOO-2099).
earn.post(
  "/vault-withdrawal-previews",
  requireAction("earn.read"),
  validateBody(earnVaultWithdrawalPreviewSchema),
  createEarnVaultWithdrawalPreview
);
// Withdrawal READS mirror the deposit reads: no request gate, no provider gate,
// collection before the `:movementId` route, `?requestId=` finds the whole leg
// group.
earn.get("/vault-withdrawals", requireAction("earn.read"), listEarnVaultWithdrawals);
earn.get("/vault-withdrawals/:movementId", requireAction("earn.read"), getEarnVaultWithdrawal);
earn.post(
  "/vault-withdrawal-options",
  requireAction("earn.read"),
  validateBody(earnVaultWithdrawalOptionsSchema),
  getEarnVaultWithdrawalOptions
);
earn.post(
  "/vault-queued-withdrawal-previews",
  requireAction("earn.read"),
  validateBody(earnVaultQueuedWithdrawalPreviewSchema),
  createEarnVaultQueuedWithdrawalPreview
);
earn.post(
  "/vault-withdrawal-requests",
  requireAction("earn.execute"),
  validateBody(earnVaultWithdrawalRequestSchema),
  requestGate({
    extract: extractEarnVaultWithdrawalRequest,
    findIdempotentKeyReplay: findEarnVaultWithdrawalRequestIdempotentKeyReplay,
  }),
  createEarnVaultWithdrawalRequest
);
earn.get("/vault-withdrawal-requests", requireAction("earn.read"), listEarnVaultWithdrawalRequests);
earn.get(
  "/vault-withdrawal-requests/:withdrawalRequestId",
  requireAction("earn.read"),
  getEarnVaultWithdrawalRequest
);
// Recovery is intentionally not request-gated: it only releases the caller's
// provider request. Solver queues return escrowed shares after their deadline;
// operator redemptions revoke the claim and leave the redeemed intermediate
// asset in the same owner wallet. `earn.manage`, the action its movement
// (`earn.queued_withdraw_cancel`) needs at the signer, so a key without it is
// refused here rather than after sponsorship, a build and a simulation.
earn.post(
  "/vault-withdrawal-requests/:withdrawalRequestId/cancel",
  requireAction("earn.manage"),
  validateBody(earnVaultWithdrawalRequestCancelSchema),
  cancelEarnVaultWithdrawalRequest
);
earn.get(
  "/vault-positions",
  requireAction("earn.read"),
  meteredQuota(EARN_CHAIN_READ_QUOTA),
  listEarnVaultPositions
);
// Chain-versus-ledger reconciliation for the custody vault claims above
// (PRO-1741): a REPORT of share balances the positions read cannot see (held
// with no recorded claim) and claims the chain no longer backs (recorded, zero
// shares). Report-only — it writes nothing — with no provider gate (it
// describes money the org already holds), project-scoped like the positions
// read, which is why it carries the same action.
earn.get(
  "/vault-share-reconciliation",
  requireAction("earn.read"),
  meteredQuota(EARN_CHAIN_READ_QUOTA),
  getEarnVaultShareReconciliation
);

// External-wallet builds, previews and submits. The deposit BUILD is money-IN,
// so it takes the same meter as the deposit quote (PRO-1994), validated first;
// the exit builds and previews carry none (see the metered-quotas note above).
//
// Deliberately NO `requestGate` and no wallet scope: a key's wallet scope
// governs the org's own custody at `createOrgSignerForCustodyWallet`. These
// routes never resolve a signer and never touch custody — the owner's own
// signature is the authorization, and there is no signing sink here for the
// value-moving conformance inventory to find. `earn.execute` gates the builds
// and submits because they create and broadcast recorded movements.
earn.post(
  "/external-wallet/deposit-transactions",
  requireAction("earn.execute"),
  validateBody(earnExternalWalletDepositTransactionSchema),
  meteredQuota(EARN_PROVIDER_READ_QUOTA),
  createEarnExternalWalletDepositTransaction
);
earn.post(
  "/external-wallet/withdrawal-previews",
  requireAction("earn.read"),
  validateBody(earnExternalWalletWithdrawalPreviewSchema),
  createEarnExternalWalletWithdrawalPreview
);
earn.post(
  "/external-wallet/withdrawal-transactions",
  requireAction("earn.execute"),
  validateBody(earnExternalWalletWithdrawalTransactionSchema),
  createEarnExternalWalletWithdrawalTransaction
);
earn.post(
  "/external-wallet/withdrawal-options",
  requireAction("earn.read"),
  validateBody(earnExternalWalletWithdrawalOptionsSchema),
  getEarnExternalWalletWithdrawalOptions
);
earn.post(
  "/external-wallet/queued-withdrawal-previews",
  requireAction("earn.read"),
  validateBody(earnExternalWalletQueuedWithdrawalPreviewSchema),
  createEarnExternalWalletQueuedWithdrawalPreview
);
earn.post(
  "/external-wallet/deposits",
  requireAction("earn.execute"),
  validateBody(earnExternalWalletSubmitSchema),
  createEarnExternalWalletDeposit
);
earn.post(
  "/external-wallet/withdrawals",
  requireAction("earn.execute"),
  validateBody(earnExternalWalletSubmitSchema),
  createEarnExternalWalletWithdrawal
);
earn.post(
  "/external-wallet/withdrawal-requests",
  requireAction("earn.execute"),
  validateBody(earnExternalWalletSubmitSchema),
  createEarnExternalWalletWithdrawalRequest
);
earn.post(
  "/external-wallet/withdrawal-request-cancellations",
  requireAction("earn.execute"),
  validateBody(earnExternalWalletSubmitSchema),
  createEarnExternalWalletWithdrawalRequestCancellation
);

// The cross-provider movement feed (source: earn_movements). One chronological
// history spanning both execution models, which no per-family list can serve —
// and like them it takes NO provider gate, because it reports on money that has
// already moved. Project-scoped like every Earn read (HOO-2099).
earn.get("/movements", requireAction("earn.read"), listEarnMovements);

// Portfolio programs: N provider wallets per org+environment+provider
// (PRO-1670), each addressed by its own id. Money-in (create, re-target) takes
// the full availability gate inside the handler; the withdrawal endpoints only
// require provider credentials (ADR 0002 exit safety — disabling a provider must
// never trap funds). Source of truth per route: list/get/deposits/
// withdrawal-detail read the provider LIVE; the withdrawals LIST reads the SDP
// ledger (custodial earn_movements rows) and takes no provider gate at all —
// the audit trail outlives credential removal.
//
// The collection is declared BEFORE the `:programId` routes so a literal
// segment can never be captured as an id.
earn.get(
  "/programs",
  requireAction("earn.read"),
  meteredQuota(EARN_PROVIDER_READ_QUOTA),
  listEarnPrograms
);
earn.post(
  "/programs",
  requireAction("earn.manage"),
  validateBody(earnProgramCreateSchema),
  createEarnProgram
);
earn.get(
  "/programs/:programId",
  requireAction("earn.read"),
  meteredQuota(EARN_PROVIDER_READ_QUOTA),
  getEarnProgram
);
earn.put(
  "/programs/:programId",
  requireAction("earn.manage"),
  validateBody(earnProgramRetargetSchema),
  retargetEarnProgram
);
earn.get(
  "/programs/:programId/deposits",
  requireAction("earn.read"),
  meteredQuota(EARN_PROVIDER_READ_QUOTA),
  listEarnProgramDeposits
);
earn.post(
  "/programs/:programId/withdrawal-preview",
  requireAction("earn.read"),
  validateBody(earnProgramWithdrawalPreviewSchema),
  previewEarnProgramWithdrawal
);
// The custodial payout. The route pays a caller-supplied `destinationAddress`
// out of the organization's provider account. A program has no custody wallet,
// so the extractor refuses a wallet-scoped key, which has no wallet here to be
// bound against. Retries are resolved by the handler over the movement ledger.
earn.post(
  "/programs/:programId/withdrawals",
  requireAction("earn.execute"),
  validateBody(earnProgramWithdrawalCreateSchema),
  requestGate({
    extract: extractEarnProgramWithdrawal,
  }),
  createEarnProgramWithdrawal
);
earn.get(
  "/programs/:programId/withdrawals",
  requireAction("earn.read"),
  listEarnProgramWithdrawals
);
earn.get(
  "/programs/:programId/withdrawals/:withdrawalRef",
  requireAction("earn.read"),
  getEarnProgramWithdrawal
);

earnRoutes.route("/", earn);
