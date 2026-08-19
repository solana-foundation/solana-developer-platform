import { z } from "zod";
import { badRequestParams, badRequestQuery } from "@/lib/errors";
import type { AppContext } from "../context";

/**
 * Request-parsing and list-envelope helpers shared by every earn handler, so
 * the zod-failure -> 400 mapping stays on one convention per input class
 * (query/params) instead of being repeated per endpoint. Body validation is
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

export function parseParams<Schema extends z.ZodType>(
  c: AppContext,
  schema: Schema
): z.output<Schema> {
  const parsed = schema.safeParse(c.req.param());

  if (!parsed.success) {
    throw badRequestParams();
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

/** The `{ <items>, total, page, pageSize }` envelope every earn list shares. */
export function listResponse<Items extends Record<string, unknown[]>>(
  { page, pageSize }: EarnPageQuery,
  total: number,
  items: Items
): Items & { total: number; page: number; pageSize: number } {
  return { ...items, total, page, pageSize };
}
