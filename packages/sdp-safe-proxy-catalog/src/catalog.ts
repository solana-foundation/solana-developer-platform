import { z } from "zod";

/** The services allowed to call Safe Proxy. Each operation lists which of them may use it. */
export const SAFE_PROXY_CALLERS = ["api", "cron"] as const;
export type SafeProxyCaller = (typeof SAFE_PROXY_CALLERS)[number];

/**
 * What an operation does at the provider, which decides what a caller does after `no_answer`:
 * `reads` repeats freely, `signs` repeats with the same bytes, `changes` repeats with the same
 * idempotency key or reads by it.
 */
export const SAFE_PROXY_OPERATION_KINDS = ["reads", "signs", "changes"] as const;
export type SafeProxyOperationKind = (typeof SAFE_PROXY_OPERATION_KINDS)[number];

/** `customer`: the request names a stored customer credential. `none`: it uses no customer credential. */
export const SAFE_PROXY_CREDENTIAL_SOURCES = ["customer", "none"] as const;
export type SafeProxyCredentialSource = (typeof SAFE_PROXY_CREDENTIAL_SOURCES)[number];

export const SAFE_PROXY_MAX_BUDGET_MS = 60_000;

type OperationKindFields =
  | { kind: "reads" }
  | { kind: "signs" }
  // An operation that changes something names the read that finds its result by idempotency key.
  | { kind: "changes"; pairedRead: `${string}.${string}` };

export type SafeProxyOperation = OperationKindFields & {
  credential: SafeProxyCredentialSource;
  callers: readonly SafeProxyCaller[];
  /** How long Safe Proxy may spend on one call. The caller waits a little longer than this. */
  budgetMs: number;
  /** Strict: a field this version does not know is refused, never dropped. */
  request: z.ZodType;
  /** The only fields that cross back to the caller. */
  response: z.ZodType;
};

type SafeProxyCatalogDefinition = Record<string, Record<string, SafeProxyOperation>>;

export function defineSafeProxyCatalog<const Definition extends SafeProxyCatalogDefinition>(
  definition: Definition
): Definition {
  for (const [section, operations] of Object.entries(definition)) {
    for (const [name, operation] of Object.entries(operations)) {
      const path = `${section}.${name}`;
      if (
        !Number.isInteger(operation.budgetMs) ||
        operation.budgetMs < 1 ||
        operation.budgetMs > SAFE_PROXY_MAX_BUDGET_MS
      ) {
        throw new Error(
          `${path}: budgetMs must be an integer from 1 to ${SAFE_PROXY_MAX_BUDGET_MS}`
        );
      }
      if (operation.callers.length === 0) {
        throw new Error(`${path}: an operation no caller may use cannot be declared`);
      }
      if (operation.kind !== "changes") {
        continue;
      }
      const [pairedSection, pairedName] = operation.pairedRead.split(".");
      const paired =
        pairedSection !== undefined &&
        pairedName !== undefined &&
        Object.hasOwn(definition, pairedSection)
          ? definition[pairedSection]?.[pairedName]
          : undefined;
      if (paired?.kind !== "reads") {
        throw new Error(`${path}: pairedRead must name a reads operation in the catalog`);
      }
    }
  }
  return definition;
}

/**
 * Every operation Safe Proxy performs. The two apps deploy separately, so a change here is additive:
 * a new operation, or a new optional field. Safe Proxy deploys before its callers.
 */
export const safeProxyCatalog = defineSafeProxyCatalog({
  system: {
    ping: {
      kind: "reads",
      credential: "none",
      callers: ["api", "cron"],
      budgetMs: 2_000,
      request: z.strictObject({}),
      response: z.object({ service: z.literal("safe-proxy") }),
    },
  },
});

export type SafeProxyCatalog = typeof safeProxyCatalog;
export type SafeProxySection = keyof SafeProxyCatalog;
export type SafeProxyOperationName<Section extends SafeProxySection> =
  keyof SafeProxyCatalog[Section];

export function findSafeProxyOperation(
  section: string,
  name: string
): SafeProxyOperation | undefined {
  const catalog: SafeProxyCatalogDefinition = safeProxyCatalog;
  if (!Object.hasOwn(catalog, section)) {
    return undefined;
  }
  const operations = catalog[section];
  if (operations === undefined || !Object.hasOwn(operations, name)) {
    return undefined;
  }
  return operations[name];
}
