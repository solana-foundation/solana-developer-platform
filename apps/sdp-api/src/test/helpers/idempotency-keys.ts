import { IDEMPOTENCY_KEY_HEADER } from "@/middleware/idempotency-key";

const KEYED_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

interface RequestableApp {
  request(input: string, init?: RequestInit, ...rest: never[]): Response | Promise<Response>;
}

/**
 * The app as a client that follows HOO-1918 sees it: every mutating request
 * carries an Idempotency-Key, a fresh one unless the test sets its own. Tests
 * of key behaviour itself (replays, reuse, the refusal) set or omit the header
 * explicitly against the bare app.
 */
export function withIdempotencyKeys<App extends RequestableApp>(app: App): Pick<App, "request"> {
  // SAFETY: the wrapper passes its arguments to app.request, adding only a
  // header, and returns app.request's result.
  return {
    request: (input: string, init: RequestInit = {}, ...rest: never[]) => {
      const method = (init.method ?? "GET").toUpperCase();
      const headers = new Headers(init.headers);
      if (KEYED_METHODS.has(method) && !headers.has(IDEMPOTENCY_KEY_HEADER)) {
        headers.set(IDEMPOTENCY_KEY_HEADER, crypto.randomUUID());
      }
      return app.request(input, { ...init, headers }, ...rest);
    },
  } as Pick<App, "request">;
}
