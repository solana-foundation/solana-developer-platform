import { currentClusterScope } from "@sdp/rpc/scope";
import { EARN_SWAP_DEFAULT_SLIPPAGE_BPS, earnSwapSourceTokens } from "@sdp/types/earn";
import { z } from "zod";
import { badRequest, badRequestQuery } from "@/lib/errors";
import type { AppContext } from "@/routes/earn/context";

/**
 * Query validation and deposit funding helpers shared by the core routes.
 * Query failures use one 400 convention. Body validation is
 * route-level middleware (`validateBody`); handlers read it via
 * `c.req.valid("json")`.
 */

export function parseQuery<Schema extends z.ZodType>(
  c: AppContext,
  schema: Schema
): z.output<Schema> {
  const parsed = schema.safeParse(c.req.query());

  if (!parsed.success) {
    throw badRequestQuery({ errors: z.treeifyError(parsed.error) });
  }

  return parsed.data;
}

export interface EarnPageQuery {
  page: number;
  pageSize: number;
}

/** Repository limit/offset window for a 1-based page query. */
export function pageWindow({ page, pageSize }: EarnPageQuery): { limit: number; offset: number } {
  return { limit: pageSize, offset: (page - 1) * pageSize };
}

/**
 * Normalize a deposit request's swap-funding fields into a validated swap
 * input, or null when no swap is needed:
 *
 * - the source mint must be one of the open cluster scope's supported
 *   swap-source stablecoins (`earnSwapSourceTokens` — pinned mints, never
 *   caller-shaped);
 * - a source equal to the vault's own deposit mint is a NO-OP, not an error,
 *   so a picker can always send its selection;
 * - `swapSlippageBps` without a swap is refused rather than ignored, because
 *   a caller who sent it believed it would do something.
 */
export function resolveDepositSwapRequest(
  body: { sourceTokenMint?: string; swapSlippageBps?: number },
  depositTokenMint: string
): { sourceTokenMint: string; slippageBps: number } | null {
  if (body.sourceTokenMint === undefined) {
    if (body.swapSlippageBps !== undefined) {
      throw badRequest("swapSlippageBps requires sourceTokenMint");
    }
    return null;
  }
  if (body.sourceTokenMint === depositTokenMint) {
    return null;
  }
  const { cluster } = currentClusterScope();
  const supported = earnSwapSourceTokens(cluster);
  if (!supported.some((token) => token.mint === body.sourceTokenMint)) {
    throw badRequest(
      `sourceTokenMint is not a supported swap funding token on ${cluster}: ` +
        supported.map((token) => `${token.symbol} (${token.mint})`).join(", ")
    );
  }
  return {
    sourceTokenMint: body.sourceTokenMint,
    slippageBps: body.swapSlippageBps ?? EARN_SWAP_DEFAULT_SLIPPAGE_BPS,
  };
}
