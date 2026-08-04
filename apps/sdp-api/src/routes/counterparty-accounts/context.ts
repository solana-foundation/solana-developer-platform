import type { Context } from "hono";
import {
  createCounterpartiesRepository,
  createCounterpartyAccountsRepository,
} from "@/db/repositories";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import type { Env } from "@/types/env";

export type AppContext = Context<{ Bindings: Env }>;

export function getCounterpartyAccountsRepository(c: AppContext) {
  return createCounterpartyAccountsRepository(c.env, getRequestTenantScope(c));
}

export function getCounterpartiesRepository(c: AppContext) {
  return createCounterpartiesRepository(c.env, getRequestTenantScope(c));
}
