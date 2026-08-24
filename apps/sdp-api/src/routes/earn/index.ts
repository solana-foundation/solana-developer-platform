import { type Context, Hono, type Next } from "hono";
import { AppError } from "@/lib/errors";
import { isEarnEnabled } from "@/lib/feature-flags";
import { requirePermissions, unifiedAuthMiddleware } from "@/middleware/auth";
import { policyGate } from "@/middleware/policy-gate";
import { projectContextMiddleware } from "@/middleware/project-context";
import { validateBody } from "@/middleware/validate";
import type { Env } from "@/types/env";
import {
  getEarnButtonConfiguration,
  getPublicEarnButtonConfiguration,
  upsertEarnButtonConfiguration,
} from "./handlers/button-configurations";
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
  createEarnVaultWithdrawal,
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
  earnButtonConfigurationSchema,
  earnProgramCreateSchema,
  earnProgramRetargetSchema,
  earnProgramWithdrawalCreateSchema,
  earnProgramWithdrawalPreviewSchema,
  earnVaultDepositSchema,
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

// Public, read-only engineering handoff. Registered before auth intentionally:
// possession of the unguessable token grants access to strategy/style only,
// never tenant metadata or an API key.
earn.get("/button-configurations/public/:publicToken", getPublicEarnButtonConfiguration);

earn.use("*", unifiedAuthMiddleware({ allowClerk: true, allowSession: true }));
earn.use("*", projectContextMiddleware());

earn.get(
  "/button-configurations/current",
  requirePermissions("earn:read"),
  getEarnButtonConfiguration
);
earn.put(
  "/button-configurations/current",
  requirePermissions("earn:write"),
  validateBody(earnButtonConfigurationSchema),
  upsertEarnButtonConfiguration
);

// Strategy catalogue (source: DB, admitted only by the sync cron).
earn.get("/strategies", requirePermissions("earn:read"), listEarnStrategies);
earn.get("/strategies/:strategyId", requirePermissions("earn:read"), getEarnStrategy);

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
