import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import { conflict } from "@/lib/errors";
import { getIdempotencyClaim, IDEMPOTENT_REPLAYED_HEADER } from "@/middleware/idempotency";
import type { Env } from "@/types/env";

const publicWallet = z
  .looseObject({ id: z.string().min(1), walletId: z.unknown().optional() })
  .transform(({ walletId: _providerReference, ...wallet }) => wallet);

const walletResponse = z.looseObject({ data: z.looseObject({ wallet: publicWallet }) });
const initializeResponse = z.looseObject({
  data: z
    .looseObject({ custodyWalletId: z.string().min(1), walletId: z.unknown().optional() })
    .transform(({ walletId: _providerReference, ...result }) => result),
});

/** Temporary: remove once all HTTP snapshots written before the cutover have expired. */
export function legacyCustodyHttpResponse(
  kind: "wallet" | "initialize"
): MiddlewareHandler<{ Bindings: Env }> {
  const schema = kind === "wallet" ? walletResponse : initializeResponse;
  return async (c, next) => {
    await next();
    // A replay with a current claim was rebuilt from a domain row in the public format.
    if (
      !c.res.ok ||
      c.res.headers.get(IDEMPOTENT_REPLAYED_HEADER) !== "true" ||
      getIdempotencyClaim(c) !== undefined
    )
      return;
    const result = schema.safeParse(c.res.body === null ? null : await c.res.clone().json());
    if (!result.success) {
      throw conflict("Custody response has no internal wallet identity");
    }
    const headers = new Headers(c.res.headers);
    headers.delete("content-length");
    c.res = new Response(JSON.stringify(result.data), { status: c.res.status, headers });
  };
}
