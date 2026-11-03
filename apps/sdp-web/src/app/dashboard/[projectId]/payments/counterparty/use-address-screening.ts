"use client";

import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";

/**
 * Whether adding a contact's address screens it first. Only a deployment whose release channel
 * runs Compliance has the screening route; anywhere else the API refuses it, and reading that
 * refusal as a finding turned every new address into a false "flagged" warning.
 *
 * @returns True when the address is screened before it is saved.
 */
export function useAddressScreeningEnabled(): boolean {
  return useDashboardWorkspace().flags.compliance;
}
