import { type Context, Hono, type Next } from "hono";
import { getCookie } from "hono/cookie";
import { extractApiKey, looksLikeApiKey } from "@/lib/api-key-format";
import { AppError } from "@/lib/errors";
import { isEarnEnabled } from "@/lib/feature-flags";
import {
  optionalAuth,
  requirePermissions,
  requirePermissionsWhenAuthenticated,
  unifiedAuthMiddleware,
} from "@/middleware/auth";
import { optionalClerkAuth } from "@/middleware/clerk-auth";
import {
  type AnonymousMeteredQuotaConfig,
  anonymousMeteredQuota,
  authenticatedMeteredQuota,
  meteredQuota,
} from "@/middleware/metered-quota";
import { policyGate } from "@/middleware/policy-gate";
import { projectContextMiddleware } from "@/middleware/project-context";
import { optionalSessionAuth } from "@/middleware/session-auth";
import { validateBody } from "@/middleware/validate";
import { SESSION_COOKIE_NAME } from "@/routes/auth/constants";
import { getLogger } from "@/runtime/logger";
import { APPROVED_OPERATION_REPLAY_HEADER } from "@/services/policy/approved-operation-replay";
import type { Env } from "@/types/env";
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
  answerEarnProgramWithdrawalConflict,
  createEarnProgram,
  createEarnProgramWithdrawal,
  extractEarnProgramWithdrawalPolicyCandidate,
  getEarnProgram,
  getEarnProgramWithdrawal,
  listEarnProgramDeposits,
  listEarnPrograms,
  listEarnProgramWithdrawals,
  previewEarnProgramWithdrawal,
  retargetEarnProgram,
} from "./handlers/program";
import { getEarnStrategy, listEarnStrategies } from "./handlers/strategies";
import {
  admitEarnVaultRuntimeExecution,
  assertEarnVaultWithdrawalFloor,
  createEarnVaultDeposit,
  createEarnVaultDepositPreview,
  createEarnVaultWithdrawal,
  createEarnVaultWithdrawalPreview,
  extractEarnVaultDepositPolicyCandidate,
  extractEarnVaultWithdrawalPolicyCandidate,
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
  earnExternalWalletSubmitSchema,
  earnExternalWalletWithdrawalPreviewSchema,
  earnExternalWalletWithdrawalTransactionSchema,
  earnProgramCreateSchema,
  earnProgramRetargetSchema,
  earnProgramWithdrawalCreateSchema,
  earnProgramWithdrawalPreviewSchema,
  earnVaultDepositPreviewSchema,
  earnVaultDepositSchema,
  earnVaultWithdrawalPreviewSchema,
  earnVaultWithdrawalSchema,
} from "./schemas";

const earnRoutes = new Hono<{ Bindings: Env }>();
const optionalAuthEarn = new Hono<{ Bindings: Env }>();
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

// Public routes authenticate a presented credential without requiring one.
// Keep the same API-key -> Clerk -> session precedence as unified auth so a
// second credential can never replace the tenant identity selected by the
// first one.
const tryApiKey = optionalAuth({ rejectInvalid: true });
const tryClerk = optionalClerkAuth({ rejectInvalid: true });
const trySession = optionalSessionAuth({ rejectInvalid: true });
async function optionalEarnAuth(c: Context<{ Bindings: Env }>, next: Next) {
  const presentedApiKey = extractApiKey(c);
  await tryApiKey(c, async () => {
    // Do not reinterpret an sk_-shaped token as Clerk auth. Unknown, revoked,
    // or expired keys were already rejected by strict optional auth.
    if (c.get("apiKey") || (presentedApiKey && looksLikeApiKey(presentedApiKey))) {
      await next();
      return;
    }
    await tryClerk(c, async () => {
      if (c.get("clerk")) {
        await next();
        return;
      }
      await trySession(c, next);
    });
  });
}

// Authenticated callers keep their verified project selection. Anonymous
// callers have no organization or project to resolve and continue untouched.
const resolveProjectContext = projectContextMiddleware();
function hasEarnAuth(c: Context<{ Bindings: Env }>): boolean {
  return Boolean(c.get("apiKey") || c.get("clerk") || c.get("session"));
}

async function optionalEarnProjectContext(c: Context<{ Bindings: Env }>, next: Next) {
  if (!hasEarnAuth(c)) {
    await next();
    return;
  }
  await resolveProjectContext(c, next);
}

async function observeEarnAccessTier(c: Context<{ Bindings: Env }>, next: Next) {
  try {
    await next();
  } finally {
    getLogger().info(
      {
        event: "sdp_api_earn_tier_request",
        tier: hasEarnAuth(c) ? "keyed" : "anonymous",
        method: c.req.method,
        route: c.req.path.startsWith("/v1/earn/strategies/")
          ? "/v1/earn/strategies/:strategyId"
          : c.req.path,
        status: c.res?.status,
      },
      "Earn tier request"
    );
  }
}

// Hono flattens sub-app `use("*")` middleware into the parent at mount time.
// Keep this tuple on the six optional-auth declarations so it can never run on
// the keyed router that shares the same mount point.
const OPTIONAL_EARN_ACCESS_MIDDLEWARE = [
  optionalEarnAuth,
  optionalEarnProjectContext,
  observeEarnAccessTier,
] as const;

const EARN_CATALOGUE_CACHE_CONTROL = "public, max-age=30, stale-while-revalidate=30";
const EARN_AUTHENTICATED_CATALOGUE_CACHE_CONTROL = "private, max-age=30";
async function cacheEarnCatalogue(c: Context<{ Bindings: Env }>, next: Next) {
  await next();
  if (c.res.status >= 200 && c.res.status < 300) {
    c.header(
      "Cache-Control",
      hasEarnAuth(c) ? EARN_AUTHENTICATED_CATALOGUE_CACHE_CONTROL : EARN_CATALOGUE_CACHE_CONTROL
    );
  }
}

const EARN_PROVIDER_READ_QUOTA = {
  name: "earn-provider-read",
  actorMax: 60,
  orgMax: 240,
} as const;
const EARN_CHAIN_READ_QUOTA = { name: "earn-chain-read", actorMax: 30, orgMax: 120 } as const;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const EARN_ANONYMOUS_RPC_QUOTA: AnonymousMeteredQuotaConfig = {
  name: "earn-rpc",
  maxRequests: (env) => positiveInteger(env.EARN_ANONYMOUS_RPC_MAX_REQUESTS, 20),
  windowMs: (env) => positiveInteger(env.EARN_ANONYMOUS_RPC_WINDOW_SECONDS, 60) * 1_000,
};

const anonymousEarnRpcQuota = anonymousMeteredQuota(EARN_ANONYMOUS_RPC_QUOTA);
// Strategy catalogue (source: DB, admitted only by the sync cron). A
// credential narrows the request exactly as before; without one, the handler
// reads only the deployment-scoped global catalogue.
optionalAuthEarn.get(
  "/strategies",
  ...OPTIONAL_EARN_ACCESS_MIDDLEWARE,
  requirePermissionsWhenAuthenticated("earn:read"),
  cacheEarnCatalogue,
  listEarnStrategies
);
optionalAuthEarn.get(
  "/strategies/:strategyId",
  ...OPTIONAL_EARN_ACCESS_MIDDLEWARE,
  requirePermissionsWhenAuthenticated("earn:read"),
  cacheEarnCatalogue,
  getEarnStrategy
);

// Catalogue/chain-only quotes and builds. These are declared exactly once on
// the optional-auth router: authenticated callers retain tenant entitlement
// and durable build behavior inside the shared handlers, while anonymous
// callers never acquire a tenant identity or write a row.
optionalAuthEarn.post(
  "/vault-deposit-previews",
  ...OPTIONAL_EARN_ACCESS_MIDDLEWARE,
  requirePermissionsWhenAuthenticated("earn:read"),
  authenticatedMeteredQuota(EARN_PROVIDER_READ_QUOTA),
  anonymousEarnRpcQuota,
  validateBody(earnVaultDepositPreviewSchema),
  createEarnVaultDepositPreview
);
optionalAuthEarn.post(
  "/external-wallet/deposit-transactions",
  ...OPTIONAL_EARN_ACCESS_MIDDLEWARE,
  requirePermissionsWhenAuthenticated("earn:write"),
  anonymousEarnRpcQuota,
  validateBody(earnExternalWalletDepositTransactionSchema),
  createEarnExternalWalletDepositTransaction
);
optionalAuthEarn.post(
  "/external-wallet/withdrawal-previews",
  ...OPTIONAL_EARN_ACCESS_MIDDLEWARE,
  requirePermissionsWhenAuthenticated("earn:read"),
  anonymousEarnRpcQuota,
  validateBody(earnExternalWalletWithdrawalPreviewSchema),
  createEarnExternalWalletWithdrawalPreview
);
optionalAuthEarn.post(
  "/external-wallet/withdrawal-transactions",
  ...OPTIONAL_EARN_ACCESS_MIDDLEWARE,
  requirePermissionsWhenAuthenticated("earn:write"),
  anonymousEarnRpcQuota,
  validateBody(earnExternalWalletWithdrawalTransactionSchema),
  createEarnExternalWalletWithdrawalTransaction
);

// Keyed routes retain dashboard auth, project membership checks, and their
// existing permission matrix. Give anonymous callers the API-facing contract
// before projectContextMiddleware can turn a missing project into a 400.
async function requireKeyedEarnCredential(c: Context<{ Bindings: Env }>, next: Next) {
  if (
    !c.req.header("Authorization") &&
    !getCookie(c, SESSION_COOKIE_NAME) &&
    !c.req.header(APPROVED_OPERATION_REPLAY_HEADER)
  ) {
    throw new AppError("UNAUTHORIZED", "API key required for this Earn route");
  }
  await next();
}

earn.use("*", requireKeyedEarnCredential);
earn.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
earn.use("*", projectContextMiddleware());

// Metered quotas for the Earn reads that fan out to a PAID upstream — the
// provider's API on a program read, Solana RPC on a live-hydrated one. A single
// `GET /programs` page is 2N provider round trips against a shared account, so
// an unmetered caller spends the platform's money at whatever rate it likes.
//
// What is deliberately NOT metered is every money-OUT route and every EXIT
// quote: withdrawals, vault withdrawals, the external-wallet submits, and the
// previews an exit derives its floor from. `meteredQuota` FAILS CLOSED — a
// counter-store outage answers 503 — and a 5xx on a customer's way out of a
// position is precisely the failure ADR 0002 exit safety rules out. A refused
// read costs a caller a retry; a refused exit traps funds.
//
// Money-IN reads carry no such rule, so the deposit quote is metered.
// B2B2C live holdings (PRO-1724). The owner is a REQUIRED query filter on
// every per-owner read of this surface (positions, movements, earnings) — one
// addressing style for one concept, and no literal segment (`summary`) can
// ever be captured as a Solana address. No `wallets:read`: these are end-user
// wallets SDP does not custody.
earn.get(
  "/external-wallet/positions/summary",
  requirePermissions("earn:read"),
  meteredQuota(EARN_CHAIN_READ_QUOTA),
  getEarnExternalWalletPositionSummary
);
earn.get(
  "/external-wallet/positions",
  requirePermissions("earn:read"),
  meteredQuota(EARN_CHAIN_READ_QUOTA),
  listEarnExternalWalletPositions
);

// B2B2C activity and earnings (PRO-1772): the reads that close the loop the
// money routes below open. Same posture as the position reads — `earn:read`
// only, no `wallets:read` (end-user wallets carry no custody bindings), and NO
// provider gate: these report on money that already moved (ADR 0002). The
// movements collection is declared before its `:movementId` detail so a
// literal segment can never be captured as an id.
earn.get(
  "/external-wallet/movements",
  requirePermissions("earn:read"),
  listEarnExternalWalletMovements
);
earn.get(
  "/external-wallet/movements/:movementId",
  requirePermissions("earn:read"),
  getEarnExternalWalletMovement
);
earn.get(
  "/external-wallet/earnings",
  requirePermissions("earn:read"),
  meteredQuota(EARN_CHAIN_READ_QUOTA),
  getEarnExternalWalletEarnings
);

// Non-custodial ("vault_direct") positions: SDP builds and signs the deposit
// from a custody wallet, so unlike /programs there is no provider wallet to
// provision and no address to fund afterwards.
//
// Both routes take the GLOBAL `wallets:read` alongside their earn scope, the
// same pairing every money-moving payments route uses. That is not belt and
// braces: for an API key with NO wallet bindings the per-wallet assertion in
// the handler is a documented NO-OP, so the router permission is the only gate
// such a key ever meets when it names a wallet.
//
// `policyGate` is what makes this route governed at all. It reaches
// `createOrgSigner` and broadcasts a value-moving transaction, so without the
// gate an org's wallet deny rules, approval requirements, amount/asset limits
// and destination controls were all bypassed — the handler simply never asked.
// The gate must sit AFTER `requirePermissions` and `validateBody`, and
// immediately before the handler, so a denial is decided before any KMS or
// relay access.
earn.post(
  "/vault-deposits",
  requirePermissions("earn:write", "wallets:read"),
  validateBody(earnVaultDepositSchema),
  policyGate({
    extract: extractEarnVaultDepositPolicyCandidate,
    findIdempotentKeyReplay: findEarnVaultDepositIdempotentKeyReplay,
    beforeEnforce: admitEarnVaultRuntimeExecution,
  }),
  createEarnVaultDeposit
);
// The deposit READS take no policy gate and no provider gate — they move no
// money and report on money that already left the wallet. They are what makes a
// signed-but-unconfirmed deposit answerable: `POST` records before broadcast,
// so a caller can hold a movement id for a transaction whose outcome it never
// saw, and the every-minute reconciliation sweep is what eventually settles it.
//
// The collection is declared BEFORE the `:movementId` route, the same ordering
// rule `/programs` follows, so a literal segment can never be captured as an id.
// `?requestId=` on the collection is how an APPROVAL-GATED deposit is found: the
// hold returns no movement id, but the approval executor replays the caller's
// original Idempotency-Key, so the movement it later creates carries it.
earn.get("/vault-deposits", requirePermissions("earn:read", "wallets:read"), listEarnVaultDeposits);
earn.get(
  "/vault-deposits/:movementId",
  requirePermissions("earn:read", "wallets:read"),
  getEarnVaultDeposit
);
// The EXIT half (PRO-1702): redeem a position's shares back to the custody
// wallet that holds them. Policy-gated for the same reason the deposit is —
// it reaches `createOrgSigner` and broadcasts value-moving transactions, and
// wallet policy is the ORG'S control over its own custody, not a provider
// gate. Beyond it this route takes only the capability answer (501 when the
// provider cannot build an exit): ADR 0002 exit safety forbids money-out
// inheriting surfacing, entitlement, availability, environment capability, or
// any catalogue dependency — the position row names the instrument, so a
// delisted vault stays exitable.
earn.post(
  "/vault-withdrawals",
  requirePermissions("earn:write", "wallets:read"),
  validateBody(earnVaultWithdrawalSchema),
  policyGate({
    extract: extractEarnVaultWithdrawalPolicyCandidate,
    findIdempotentKeyReplay: findEarnVaultWithdrawalIdempotentKeyReplay,
    // Floor policy runs AFTER the completed-replay exit so a recorded
    // floor-less withdrawal stays replayable if the provider's policy flips.
    beforeEnforce: async (c, extraction) => {
      await assertEarnVaultWithdrawalFloor(c, extraction);
      await admitEarnVaultRuntimeExecution(c, extraction);
    },
  }),
  createEarnVaultWithdrawal
);
// The exit QUOTE: a read with EXIT gates only — position scoping and the
// read-side wallet binding (both 404), capability (501), and deliberately
// nothing money-in-shaped (ADR 0002 exit safety): no surfacing, no
// entitlement, no admission, no environment capability.
earn.post(
  "/vault-withdrawal-previews",
  // wallets:read is NOT a money-in gate, so ADR 0002 does not argue for
  // dropping it — and dropping it is load-bearing the wrong way: for a key
  // with no wallet bindings the binding check is a documented no-op, so
  // earn:read alone would read any org position's live payout here while
  // GET /vault-positions answers the same key 403.
  requirePermissions("earn:read", "wallets:read"),
  validateBody(earnVaultWithdrawalPreviewSchema),
  createEarnVaultWithdrawalPreview
);
// Withdrawal READS mirror the deposit reads: no policy gate, no provider gate,
// collection before the `:movementId` route, `?requestId=` finds the whole leg
// group (including one an approval executor created later).
earn.get(
  "/vault-withdrawals",
  requirePermissions("earn:read", "wallets:read"),
  listEarnVaultWithdrawals
);
earn.get(
  "/vault-withdrawals/:movementId",
  requirePermissions("earn:read", "wallets:read"),
  getEarnVaultWithdrawal
);
earn.get(
  "/vault-positions",
  requirePermissions("earn:read", "wallets:read"),
  meteredQuota(EARN_CHAIN_READ_QUOTA),
  listEarnVaultPositions
);
// Chain-versus-ledger reconciliation for the custody vault claims above
// (PRO-1741): a REPORT of share balances the positions read cannot see (held
// with no recorded claim) and claims the chain no longer backs (recorded, zero
// shares). Report-only — it writes nothing — with no provider gate (it
// describes money the org already holds) and the positions read's exact
// wallet-binding scope, which is why it carries the same permission pair.
earn.get(
  "/vault-share-reconciliation",
  requirePermissions("earn:read", "wallets:read"),
  meteredQuota(EARN_CHAIN_READ_QUOTA),
  getEarnVaultShareReconciliation
);

// External-wallet SUBMIT routes remain keyed. Their BUILD and preview partners
// live on the optional-auth router above, each declared exactly once.
//
// Deliberately NO `policyGate` and NO `wallets:read`, and that is not the
// deposit route's cautionary tale repeating: wallet policy governs the org's
// own custody and stands between a request and `createOrgSigner`. These routes
// never resolve a signer and never touch custody — the owner's own
// signature is the authorization, and there is no signing sink here for the
// value-moving conformance inventory to find. `earn:write` gates both submits
// because they create and broadcast recorded movements.
earn.post(
  "/external-wallet/deposits",
  requirePermissions("earn:write"),
  validateBody(earnExternalWalletSubmitSchema),
  createEarnExternalWalletDeposit
);
earn.post(
  "/external-wallet/withdrawals",
  requirePermissions("earn:write"),
  validateBody(earnExternalWalletSubmitSchema),
  createEarnExternalWalletWithdrawal
);

// The cross-provider movement feed (source: earn_movements). One chronological
// history spanning both execution models, which no per-family list can serve —
// and like them it takes NO provider gate, because it reports on money that has
// already moved. `wallets:read` is required for the same reason the vault reads
// require it: the wallet-binding scope it enforces is what keeps a key bound to
// particular wallets from seeing movements signed by others.
earn.get("/movements", requirePermissions("earn:read", "wallets:read"), listEarnMovements);

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
  requirePermissions("earn:read"),
  meteredQuota(EARN_PROVIDER_READ_QUOTA),
  listEarnPrograms
);
earn.post(
  "/programs",
  requirePermissions("earn:write"),
  validateBody(earnProgramCreateSchema),
  createEarnProgram
);
earn.get(
  "/programs/:programId",
  requirePermissions("earn:read"),
  meteredQuota(EARN_PROVIDER_READ_QUOTA),
  getEarnProgram
);
earn.put(
  "/programs/:programId",
  requirePermissions("earn:write"),
  validateBody(earnProgramRetargetSchema),
  retargetEarnProgram
);
earn.get(
  "/programs/:programId/deposits",
  requirePermissions("earn:read"),
  meteredQuota(EARN_PROVIDER_READ_QUOTA),
  listEarnProgramDeposits
);
earn.post(
  "/programs/:programId/withdrawal-preview",
  requirePermissions("earn:read"),
  validateBody(earnProgramWithdrawalPreviewSchema),
  previewEarnProgramWithdrawal
);
// The custodial payout. `earn:write` alone used to be the whole gate: the
// route pays a caller-supplied `destinationAddress` out of the organization's
// provider account, so without a policy gate an org's deny rules, amount and
// asset limits, destination controls and approval requirements never ran
// (HOO-1559). A program has no custody wallet, so the governing profile is the
// API key's own; the extractor also refuses a wallet-scoped key, which has no
// wallet here to be bound against.
earn.post(
  "/programs/:programId/withdrawals",
  requirePermissions("earn:write"),
  validateBody(earnProgramWithdrawalCreateSchema),
  policyGate({
    extract: extractEarnProgramWithdrawalPolicyCandidate,
    onIdempotencyConflict: answerEarnProgramWithdrawalConflict,
  }),
  createEarnProgramWithdrawal
);
earn.get(
  "/programs/:programId/withdrawals",
  requirePermissions("earn:read"),
  listEarnProgramWithdrawals
);
earn.get(
  "/programs/:programId/withdrawals/:withdrawalRef",
  requirePermissions("earn:read"),
  getEarnProgramWithdrawal
);

earnRoutes.route("/", optionalAuthEarn);
earnRoutes.route("/", earn);

export default earnRoutes;
