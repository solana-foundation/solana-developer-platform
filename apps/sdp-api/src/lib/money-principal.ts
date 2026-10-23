import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { AppError } from "@/lib/errors";

/**
 * Who a request or job moves money for (HOO-2099). The signing waists read it
 * when asked to sign a start, from the one admission read they already make,
 * and refuse a principal that is no longer live, does not hold the movement's
 * action, or may not sign with that custody wallet.
 *
 * It is ambient only. Handlers never pass a principal, so none can name a
 * more privileged one. Only the entry points that authenticated it set it:
 * the API-key and Clerk auth middleware, the recurring-payment job (as the
 * mandate it collects), and `/pay` (as the payment request its link names).
 * `pnpm check:value-movement` pins {@link runAsMoneyPrincipal} to those files.
 *
 * - `api_key`: live when active, unexpired and within any rotation deadline;
 *   holds its grants; signs with its wallet scope.
 * - `member`: live while the organization membership is active; starts money
 *   only while still a member of the project; holds its organization role's
 *   actions; signs with every wallet in the project.
 * - `mandate`: a recurring payment (APE-343), admitted by its own row (status,
 *   source wallet), never by whoever created or activated it.
 * - `payment_request`: a `/pay` link, admitted by its own open request.
 */
export const moneyPrincipalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("api_key"), apiKeyId: z.string() }),
  z.object({ kind: z.literal("member"), userId: z.string() }),
  z.object({ kind: z.literal("mandate"), recurringPaymentId: z.string() }),
  z.object({ kind: z.literal("payment_request"), paymentRequestId: z.string() }),
]);

export type MoneyPrincipal = Readonly<z.infer<typeof moneyPrincipalSchema>>;

export type MoneyPrincipalKind = MoneyPrincipal["kind"];

const principalStorage = new AsyncLocalStorage<MoneyPrincipal>();

function principalId(principal: MoneyPrincipal): string {
  switch (principal.kind) {
    case "api_key":
      return principal.apiKeyId;
    case "member":
      return principal.userId;
    case "mandate":
      return principal.recurringPaymentId;
    case "payment_request":
      return principal.paymentRequestId;
    default: {
      const exhaustive: never = principal;
      throw new Error(`Unknown money principal: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** `kind:id`, for refusal events and sponsorship attribution. */
export function describeMoneyPrincipal(principal: MoneyPrincipal): string {
  return `${principal.kind}:${principalId(principal)}`;
}

function samePrincipal(a: MoneyPrincipal, b: MoneyPrincipal): boolean {
  return a.kind === b.kind && principalId(a) === principalId(b);
}

/**
 * Run `fn` as `principal`. Re-entering with the same principal is a no-op; a
 * different one throws, so nothing nested under an authenticated request can
 * swap who it signs for.
 *
 * SECURITY: callable only from the authenticating entry points (see the module
 * comment); adding a caller is a security-reviewed change.
 */
export function runAsMoneyPrincipal<T>(principal: MoneyPrincipal, fn: () => T): T {
  const id = principalId(principal).trim();
  if (!id) {
    throw new AppError("INTERNAL_ERROR", "A money principal needs an id");
  }
  const current = principalStorage.getStore();
  if (current) {
    if (!samePrincipal(current, principal)) {
      throw new AppError("INTERNAL_ERROR", "A money principal is already set for this work");
    }
    return fn();
  }
  return principalStorage.run(Object.freeze({ ...principal }), fn);
}

/** The principal the current request or job moves money for, or null outside one. */
export function currentMoneyPrincipal(): MoneyPrincipal | null {
  return principalStorage.getStore() ?? null;
}

/**
 * Who to record as having started a mandate (activated or resumed a recurring
 * payment), from the ambient principal: an API key or a member. Null for the
 * job (a mandate recovering its own operation) and outside any principal, so
 * the stored activator is kept.
 */
export function currentMandateActivator():
  | { apiKeyId: string; userId: null }
  | { apiKeyId: null; userId: string }
  | null {
  const principal = currentMoneyPrincipal();
  switch (principal?.kind) {
    case "api_key":
      return { apiKeyId: principal.apiKeyId, userId: null };
    case "member":
      return { apiKeyId: null, userId: principal.userId };
    default:
      return null;
  }
}
