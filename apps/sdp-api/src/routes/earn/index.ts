import { type Context, Hono, type Next } from "hono";
import { AppError } from "@/lib/errors";
import { isEarnEnabled } from "@/lib/feature-flags";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { policyGate } from "@/middleware/policy-gate";
import { projectContextMiddleware } from "@/middleware/project-context";
import { validateBody } from "@/middleware/validate";
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
  createEarnProgram,
  createEarnProgramWithdrawal,
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
import {
  earnExternalWalletDepositTransactionSchema,
  earnExternalWalletSubmitSchema,
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

earn.use("*", requireEarnFeature);

earn.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
earn.use("*", projectContextMiddleware());

// Strategy catalogue (source: DB, admitted only by the sync cron).
earn.get("/strategies", requirePermissions("earn:read"), listEarnStrategies);
earn.get("/strategies/:strategyId", requirePermissions("earn:read"), getEarnStrategy);

// B2B2C live holdings (PRO-1724). The owner is a REQUIRED query filter on
// every per-owner read of this surface (positions, movements, earnings) — one
// addressing style for one concept, and no literal segment (`summary`) can
// ever be captured as a Solana address. No `wallets:read`: these are end-user
// wallets SDP does not custody.
earn.get(
  "/external-wallet/positions/summary",
  requirePermissions("earn:read"),
  getEarnExternalWalletPositionSummary
);
earn.get(
  "/external-wallet/positions",
  requirePermissions("earn:read"),
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
  }),
  createEarnVaultDeposit
);
// The deposit QUOTE: a read carrying the deposit's own money-in gates (it
// exists only to open a new position) but no policy gate, no wallet and no
// idempotency key — it moves nothing. POST because the parameters are a body,
// exactly like the custodial withdrawal-preview.
earn.post(
  "/vault-deposit-previews",
  requirePermissions("earn:read"),
  validateBody(earnVaultDepositPreviewSchema),
  createEarnVaultDepositPreview
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
  listEarnVaultPositions
);

// External-wallet (caller-signed) vault flows (PRO-1722): the B2B2C money
// path, where an external (non-custodial) wallet signs. Each direction is a
// BUILD (returns an unsigned transaction; full money-in gates on the deposit,
// exit-safety scoping only on the withdrawal) and a SUBMIT (verifies the
// signature over the exact built message, records the movement, broadcasts).
//
// Deliberately NO `policyGate` and NO `wallets:read`, and that is not the
// deposit route's cautionary tale repeating: wallet policy governs the org's
// own custody and stands between a request and `createOrgSigner`. These routes
// never resolve a signer and never touch custody — the owner's own
// signature is the authorization, and there is no signing sink here for the
// value-moving conformance inventory to find. `earn:write` still gates all
// four, because building and recording money movements is a write surface.
earn.post(
  "/external-wallet/deposit-transactions",
  requirePermissions("earn:write"),
  validateBody(earnExternalWalletDepositTransactionSchema),
  createEarnExternalWalletDepositTransaction
);
earn.post(
  "/external-wallet/deposits",
  requirePermissions("earn:write"),
  validateBody(earnExternalWalletSubmitSchema),
  createEarnExternalWalletDeposit
);
earn.post(
  "/external-wallet/withdrawal-previews",
  requirePermissions("earn:read"),
  validateBody(earnVaultWithdrawalPreviewSchema),
  createEarnExternalWalletWithdrawalPreview
);
earn.post(
  "/external-wallet/withdrawal-transactions",
  requirePermissions("earn:write"),
  validateBody(earnExternalWalletWithdrawalTransactionSchema),
  createEarnExternalWalletWithdrawalTransaction
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
earn.get("/programs", requirePermissions("earn:read"), listEarnPrograms);
earn.post(
  "/programs",
  requirePermissions("earn:write"),
  validateBody(earnProgramCreateSchema),
  createEarnProgram
);
earn.get("/programs/:programId", requirePermissions("earn:read"), getEarnProgram);
earn.put(
  "/programs/:programId",
  requirePermissions("earn:write"),
  validateBody(earnProgramRetargetSchema),
  retargetEarnProgram
);
earn.get("/programs/:programId/deposits", requirePermissions("earn:read"), listEarnProgramDeposits);
earn.post(
  "/programs/:programId/withdrawal-preview",
  requirePermissions("earn:read"),
  validateBody(earnProgramWithdrawalPreviewSchema),
  previewEarnProgramWithdrawal
);
earn.post(
  "/programs/:programId/withdrawals",
  requirePermissions("earn:write"),
  validateBody(earnProgramWithdrawalCreateSchema),
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

export default earn;
