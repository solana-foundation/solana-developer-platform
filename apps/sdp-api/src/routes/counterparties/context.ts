import type { Context } from "hono";
import {
  createCounterpartiesRepository,
  createCounterpartyAccountsRepository,
} from "@/db/repositories";
import type { Env } from "@/types/env";

export type AppContext = Context<{ Bindings: Env }>;

export function getCounterpartiesRepository(c: AppContext) {
  return createCounterpartiesRepository(c.env);
}

export function getCounterpartyAccountsRepository(c: AppContext) {
  return createCounterpartyAccountsRepository(c.env);
}
