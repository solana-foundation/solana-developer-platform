import { RAMP_PROVIDERS, UNIFIED_TRANSACTION_SDP_MODULES } from "@sdp/types";
import { getDb } from "@/db";
import { createPostgresUnifiedTransactionsRepository } from "@/db/repositories/unified-transactions.repository.postgres";
import { getAuth } from "@/lib/auth";
import { forbidden, insufficientPermissions } from "@/lib/errors";
import { success } from "@/lib/response";
import { grantedPermissions } from "@/middleware/auth";
import {
  assertModuleInChannel,
  isModuleInChannel,
  isRampProviderInChannel,
} from "@/middleware/require-module";
import type { ValidatedContext } from "@/middleware/validate";
import { getAllowedApiKeyWalletAuthorizationForPermissions } from "@/services/api-key-scope.service";
import {
  permittedUnifiedTransactionModules,
  UNIFIED_TRANSACTION_MODULE_PERMISSIONS,
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
  const granted = grantedPermissions(c);
  const grantedModules = permittedUnifiedTransactionModules(granted);
  if (
    grantedModules.length === 0 ||
    (query.module !== undefined && !grantedModules.includes(query.module))
  ) {
    throw insufficientPermissions();
  }
  // Rows of a module the release channel leaves out are not listed (ADR 0005).
  const permittedModules = grantedModules.filter((module) =>
    isModuleInChannel(c, UNIFIED_TRANSACTION_SDP_MODULES[module])
  );
  if (permittedModules.length === 0) {
    return success(c, { transactions: [], nextCursor: null });
  }
  const moduleWalletScopes = permittedModules.flatMap((module) => {
    const authorization = getAllowedApiKeyWalletAuthorizationForPermissions(auth, [
      UNIFIED_TRANSACTION_MODULE_PERMISSIONS[module],
    ]);
    return authorization === null
      ? []
      : [{ module, custodyWalletIds: authorization.custodyWalletIds }];
  });
  const walletScoped = moduleWalletScopes.length > 0;
  const requestedWallet = query.custodyWalletId;
  if (
    walletScoped &&
    requestedWallet !== undefined &&
    !moduleWalletScopes.some((scope) => scope.custodyWalletIds.includes(requestedWallet))
  ) {
    throw forbidden("API key is not authorized for the requested wallet");
  }
  const repository = createPostgresUnifiedTransactionsRepository(getDb(c.env));
  const result = await repository.list({
    ...query,
    modules: permittedModules,
    // Ramp transfers are Payments rows, so an excluded provider is filtered by its stored provider.
    excludedRampProviders: RAMP_PROVIDERS.filter(
      (provider) => !isRampProviderInChannel(c, provider)
    ),
    organizationId: auth.organizationId,
    projectId: auth.projectId,
    moduleWalletScopes: walletScoped ? moduleWalletScopes : undefined,
  });
  return success(c, { transactions: result.rows, nextCursor: result.nextCursor });
}
