"use client";

import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";

/**
 * Whether the dashboard offers Ramps here, the module behind a bank payout and a card or bank
 * deposit: the release channel runs it and at least one ramp provider is on (`flags.ramps`).
 * Anywhere else Pay and Deposit offer no fiat option at all, whatever a provider's own settings
 * say.
 *
 * @returns True when fiat options may show.
 */
export function useRampsOffered(): boolean {
  return useDashboardWorkspace().flags.ramps;
}
