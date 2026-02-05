/**
 * Allowlist Service
 *
 * Delegates allowlist operations to Clerk.
 */

import type { Env } from "@/types/env";
import { ClerkAllowlistService } from "./clerk-allowlist.service";

export interface AllowlistEntry {
  id: string;
  type: "email" | "domain";
  value: string;
  tier: string;
  notes: string | null;
  status: "active" | "disabled";
  createdAt: string;
}

export type AllowlistProvider = ClerkAllowlistService;

export function createAllowlistService(env: Env): AllowlistProvider {
  return new ClerkAllowlistService(env);
}
