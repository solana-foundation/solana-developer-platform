import { z } from "zod";
import type { SafeProxyCaller } from "./callers";

export const digits = z.string().regex(/^[0-9]{1,100}$/);
export const token = z.string().regex(/^[A-Za-z0-9_-]{1,255}$/);

export interface BodyRule {
  field: string;
  values: readonly [string, ...string[]];
}

export interface AllowedEndpoint {
  method: "GET" | "POST";
  path: string;
  parameters: Readonly<Record<string, z.ZodType<string>>>;
  query: readonly string[];
  callers: readonly [SafeProxyCaller, ...SafeProxyCaller[]];
  requestHeaders: readonly string[];
  body?: BodyRule;
}

export interface ProviderDeclaration {
  hosts: readonly [string, ...string[]];
  endpoints: readonly AllowedEndpoint[];
}
