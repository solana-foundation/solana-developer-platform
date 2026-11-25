import type { SolanaCluster } from "@sdp/types/well-known-tokens";
import { z } from "zod";
import type { SafeProxyCaller } from "./callers";

export const digits = z.string().regex(/^[0-9]{1,100}$/);
export const token = z.string().regex(/^[A-Za-z0-9_-]{1,255}$/);

export interface AllowedEndpoint {
  method: "GET" | "POST";
  path: string;
  parameters: Readonly<Record<string, z.ZodType<string>>>;
  query: readonly string[];
  callers: readonly [SafeProxyCaller, ...SafeProxyCaller[]];
  requestHeaders: readonly string[];
  body?: z.ZodType;
}

export interface ProviderDeclaration {
  hosts: Readonly<Record<SolanaCluster, string | null>>;
  endpoints: readonly AllowedEndpoint[];
}
