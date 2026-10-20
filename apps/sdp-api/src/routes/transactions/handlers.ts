import { type Action, isActionInReleaseChannel } from "@sdp/types/actions";
import { RAMP_PROVIDERS } from "@sdp/types/provider-access";
import {
  PAYMENT_TRANSACTION_KINDS,
  type PaymentTransactionKind,
  UNIFIED_TRANSACTION_SDP_MODULES,
} from "@sdp/types/unified-transactions";
import type { Context } from "hono";
import { z } from "zod";
import { getDb } from "@/db/client";
import { createPostgresUnifiedTransactionsRepository } from "@/db/repositories/unified-transactions.repository.postgres";
import { getAuth } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { success } from "@/lib/response";
import { callerMayPerform } from "@/middleware/require-action";
import {
  assertModuleInChannel,
  isModuleInChannel,
  isRampProviderInChannel,
} from "@/middleware/require-module";
import type { ValidatedContext } from "@/middleware/validate";
import type { Env } from "@/types/env";
import {
  PAYMENT_TRANSACTION_KIND_ACTIONS,
  permittedPaymentTransactionKinds,
  permittedUnifiedTransactionModules,
  UNIFIED_TRANSACTION_MODULE_ACTIONS,
} from "./module-permissions";
import type { UnifiedTransactionsQuery, unifiedTransactionsQuerySchema } from "./schemas";

export async function listUnifiedTransactions(
  c: ValidatedContext<{ query: typeof unifiedTransactionsQuerySchema }>
) {
  const auth = getAuth(c);
  const query: UnifiedTransactionsQuery = c.req.valid("query");
  if (query.module !== undefined) {
    assertModuleInChannel(c, UNIFIED_TRANSACTION_SDP_MODULES[query.module]);
  }
  const grantedModules = permittedUnifiedTransactionModules((action) =>
    callerMayPerform(c, action)
  );
  if (query.module !== undefined && !grantedModules.includes(query.module)) {
    const action = UNIFIED_TRANSACTION_MODULE_ACTIONS[query.module];
    throw new AppError("INSUFFICIENT_PERMISSIONS", `Missing action: ${action}`, { action });
  }
  // Each kind of Payments row also needs the read of the module it comes
  // from, and that module in the release channel.
  const paymentKinds = permittedPaymentTransactionKinds(
    (action) => callerMayPerform(c, action) && isActionInChannel(c, action)
  );
  if (query.module === "payments" && query.kind !== undefined) {
    assertPaymentKindPermitted(query.kind, paymentKinds);
  }
  // Rows of a module the release channel leaves out are not listed (ADR 0005).
  const permittedModules = grantedModules.filter(
    (module) =>
      isModuleInChannel(c, UNIFIED_TRANSACTION_SDP_MODULES[module]) &&
      (module !== "payments" || paymentKinds.length > 0)
  );
  if (permittedModules.length === 0) {
    return success(c, { transactions: [], nextCursor: null });
  }
  const repository = createPostgresUnifiedTransactionsRepository(getDb(c.env));
  const result = await repository.list({
    ...query,
    modules: permittedModules,
    paymentKinds,
    // Ramp transfers are Payments rows, so an excluded provider is filtered by its stored provider.
    excludedRampProviders: RAMP_PROVIDERS.filter(
      (provider) => !isRampProviderInChannel(c, provider)
    ),
    organizationId: auth.organizationId,
    projectId: auth.projectId,
  });
  return success(c, { transactions: result.rows, nextCursor: result.nextCursor });
}

function isActionInChannel(c: Context<{ Bindings: Env }>, action: Action): boolean {
  return isActionInReleaseChannel(action, (module) => isModuleInChannel(c, module));
}

const paymentTransactionKindSchema = z.enum(PAYMENT_TRANSACTION_KINDS);

/** A Payments kind filter the caller cannot read is refused, naming the read it lacks. */
function assertPaymentKindPermitted(
  kind: string,
  paymentKinds: readonly PaymentTransactionKind[]
): void {
  // The query schema already checked the kind against the Payments kinds.
  const requested = paymentTransactionKindSchema.parse(kind);
  if (paymentKinds.includes(requested)) return;
  const action = PAYMENT_TRANSACTION_KIND_ACTIONS[requested];
  throw new AppError("INSUFFICIENT_PERMISSIONS", `Missing action: ${action}`, { action });
}
