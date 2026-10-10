import { IDEMPOTENCY_KEY_HEADER } from "@/middleware/idempotency-key";

const KEYED_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

interface RequestableApp {
  request(input: string, init?: RequestInit, ...rest: never[]): Response | Promise<Response>;
}

/**
 * The app as a client that follows HOO-1918 sees it: every mutating request
 * carries an Idempotency-Key, a fresh one unless the test sets its own. Tests
 * of key behaviour itself (replays, reuse, the refusal) set or omit the header
 * explicitly against the bare app. `only` limits keying to matching paths, for
 * suites whose other routes test their own key handling.
 */
export function withIdempotencyKeys<App extends RequestableApp>(
  app: App,
  options: { only?: RegExp } = {}
): App {
  return new Proxy(app, {
    get(target, property, receiver) {
      if (property !== "request") return Reflect.get(target, property, receiver);
      return (input: string, init: RequestInit = {}, ...rest: never[]) => {
        const method = (init.method ?? "GET").toUpperCase();
        const headers = new Headers(init.headers);
        const inScope = options.only === undefined || options.only.test(input);
        if (inScope && KEYED_METHODS.has(method) && !headers.has(IDEMPOTENCY_KEY_HEADER)) {
          headers.set(IDEMPOTENCY_KEY_HEADER, crypto.randomUUID());
        }
        return target.request(input, { ...init, headers }, ...rest);
      };
    },
  });
}

/** Approving an approval request requires a key (HOO-1918). */
export const APPROVAL_DECISION_PATH = /\/approval-requests\/[^/]+\/approve$/;
