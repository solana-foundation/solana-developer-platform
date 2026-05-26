import type { Context } from "hono";
import { createCounterpartiesRepository } from "@/db/repositories";
import type { Env } from "@/types/env";

export type AppContext = Context<{ Bindings: Env }>;

export function getCounterpartiesRepository(c: AppContext) {
  return createCounterpartiesRepository(c.env);
}
