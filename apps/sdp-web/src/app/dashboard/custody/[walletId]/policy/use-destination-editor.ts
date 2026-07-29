"use client";

import type { CounterpartyAccountSummary } from "@sdp/types";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import useSWR from "swr";
import {
  fetchBatchRecipients,
  getHighRiskProviders,
  runComplianceCheck,
} from "@/app/dashboard/payments/payments-workspace.data";
import type { ComplianceSnapshot } from "@/app/dashboard/payments/payments-workspace.types";
import { useTranslations } from "@/i18n/provider";
import { ComplianceNotEnabledError } from "@/lib/compliance";
import {
  type DestinationMode,
  isValidSolanaAddress,
  type ParsedDestinations,
  type PolicyAuthoringState,
  parseDestinationText,
} from "./wallet-policy-authoring";

type DestinationScreeningPhase = "idle" | "screening" | "revealing" | "risk";

interface FlaggedDestination {
  address: string;
  unavailable: boolean;
}

/**
 * Resolves which authoring text field the given destination mode edits.
 *
 * @param mode - The active allow/block destination mode.
 * @returns The matching `PolicyAuthoringState` text field name.
 */
function destinationField(mode: DestinationMode): "destinationAllowText" | "destinationBlockText" {
  return mode === "allowlist" ? "destinationAllowText" : "destinationBlockText";
}

/**
 * Collects the screening results that should block an unattended add: high-risk
 * verdicts plus providers that did not return a usable result.
 *
 * @param snapshot - The completed screening snapshot.
 * @returns The provider results that make the address require review.
 */
function riskyProviders(snapshot: ComplianceSnapshot) {
  return [
    ...getHighRiskProviders(snapshot),
    ...snapshot.providers.filter((provider) => provider.status !== "ok"),
  ];
}

interface DestinationScreeningResult {
  risky: boolean;
  unavailable: boolean;
  notEnabled: boolean;
  snapshot: ComplianceSnapshot | null;
}

/**
 * Screens one destination address and folds every outcome — clean, risky,
 * provider unavailable, or compliance not enabled for the org — into one shape
 * shared by the single-add and bulk-paste paths.
 *
 * @param address - The destination address to screen.
 * @returns The screening outcome for the address.
 */
async function screenDestination(address: string): Promise<DestinationScreeningResult> {
  try {
    const snapshot = await runComplianceCheck(address, "transfer_destination");
    if (snapshot.providers.length === 0) {
      return { risky: true, unavailable: true, notEnabled: false, snapshot: null };
    }
    return {
      risky: riskyProviders(snapshot).length > 0,
      unavailable: false,
      notEnabled: false,
      snapshot,
    };
  } catch (screeningError) {
    if (screeningError instanceof ComplianceNotEnabledError) {
      return { risky: false, unavailable: false, notEnabled: true, snapshot: null };
    }
    return { risky: true, unavailable: true, notEnabled: false, snapshot: null };
  }
}

/**
 * State machine behind the destination editor: counterparty search, single-add
 * compliance screening, bulk paste with batched screening, and per-mode
 * commit/removal against the authoring state's allow and block lists.
 *
 * @param state - The current policy authoring state.
 * @param setPolicyState - Updater for the authoring state.
 * @param complianceScreeningEnabled - Whether the organization has a compliance provider enabled; without one, allowlist adds commit directly instead of screening.
 * @returns Editor state and the handlers the destination editor renders with.
 */
export function useDestinationEditor(
  state: PolicyAuthoringState,
  setPolicyState: (update: (current: PolicyAuthoringState) => PolicyAuthoringState) => void,
  complianceScreeningEnabled: boolean
) {
  const t = useTranslations();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [inputError, setInputError] = useState<"invalid" | "duplicate" | null>(null);
  const [phase, setPhase] = useState<DestinationScreeningPhase>("idle");
  const [pendingAddress, setPendingAddress] = useState("");
  const [snapshot, setSnapshot] = useState<ComplianceSnapshot | null>(null);
  const [screenUnavailable, setScreenUnavailable] = useState(false);
  const [flagged, setFlagged] = useState<FlaggedDestination[]>([]);
  const { data: accountsResult } = useSWR(
    "policy-destination-accounts",
    () => fetchBatchRecipients({ pageSize: 100 }, t),
    { revalidateOnFocus: false }
  );

  const accounts = useMemo(() => (accountsResult ? accountsResult.accounts : []), [accountsResult]);
  const accountByAddress = useMemo(
    () =>
      new Map<string, CounterpartyAccountSummary>(
        accounts.map((account) => [account.address, account])
      ),
    [accounts]
  );
  const activeText = state[destinationField(state.destinationMode)];
  const parsed = useMemo(() => parseDestinationText(activeText), [activeText]);
  const trimmedQuery = query.trim();
  const normalizedQuery = trimmedQuery.toLowerCase();
  const matchingAccounts = accounts.filter(
    (account) =>
      !normalizedQuery ||
      account.name.toLowerCase().includes(normalizedQuery) ||
      account.label?.toLowerCase().includes(normalizedQuery) ||
      account.address.toLowerCase().includes(normalizedQuery)
  );
  const canAddExternal =
    isValidSolanaAddress(trimmedQuery) &&
    !parsed.valid.includes(trimmedQuery) &&
    !matchingAccounts.some((account) => account.address === trimmedQuery);
  const busy = phase === "screening" || phase === "revealing";
  const hasRisk = (snapshot ? riskyProviders(snapshot).length > 0 : false) || screenUnavailable;

  function resetScreening() {
    setPendingAddress("");
    setSnapshot(null);
    setScreenUnavailable(false);
    setPhase("idle");
  }

  function commitMany(values: string[], field: "destinationAllowText" | "destinationBlockText") {
    setPolicyState((current) => ({
      ...current,
      [field]: [...parseDestinationText(current[field]).valid, ...values].join(", "),
    }));
  }

  function clearEntry() {
    setQuery("");
    setInputError(null);
    resetScreening();
  }

  function dismissFlagged(address: string) {
    setFlagged((current) => current.filter((item) => item.address !== address));
  }

  function commitFlagged(address: string) {
    commitMany([address], "destinationAllowText");
    dismissFlagged(address);
  }

  function commitPending() {
    commitMany([pendingAddress], "destinationAllowText");
    clearEntry();
  }

  function removeDestination(value: string) {
    setPolicyState((current) => {
      const field = destinationField(current.destinationMode);
      return {
        ...current,
        [field]: parseDestinationText(current[field])
          .valid.filter((entry) => entry !== value)
          .join(", "),
      };
    });
  }

  async function requestAdd(value: string) {
    if (busy) return;
    if (!isValidSolanaAddress(value)) {
      setInputError("invalid");
      return;
    }
    if (parsed.valid.includes(value)) {
      setInputError("duplicate");
      return;
    }
    setInputError(null);
    setOpen(false);
    if (state.destinationMode === "blocklist") {
      commitMany([value], "destinationBlockText");
      clearEntry();
      return;
    }
    if (!complianceScreeningEnabled) {
      commitMany([value], "destinationAllowText");
      clearEntry();
      return;
    }
    setPendingAddress(value);
    setPhase("screening");
    const result = await screenDestination(value);
    if (result.notEnabled) {
      commitMany([value], "destinationAllowText");
      clearEntry();
      return;
    }
    if (!result.snapshot) {
      setScreenUnavailable(true);
      setPhase("risk");
      return;
    }
    setSnapshot(result.snapshot);
    setPhase("revealing");
    if (!result.risky) commitMany([value], "destinationAllowText");
  }

  /**
   * Adds every address from a multi-address paste. Blocklist entries commit
   * directly; allowlist entries are screened concurrently, with clean addresses
   * committed and risky or unscreenable ones queued for per-address review.
   *
   * @param bulkParsed - The parsed comma- or newline-separated paste.
   * @returns Resolves once all addresses are committed or queued for review.
   */
  async function handleBulkPaste(bulkParsed: ParsedDestinations) {
    if (busy) return;
    const existing = new Set(parsed.valid);
    const candidates = [...new Set(bulkParsed.valid)].filter((entry) => !existing.has(entry));
    if (candidates.length === 0) {
      toast.error(t("DashboardCustody.policyBulkNothingToAdd"), { position: "bottom-right" });
      return;
    }
    if (state.destinationMode === "blocklist" || !complianceScreeningEnabled) {
      commitMany(candidates, destinationField(state.destinationMode));
      toast.success(
        t("DashboardCustody.policyBulkAddSummary", { added: candidates.length, flagged: 0 }),
        { position: "bottom-right" }
      );
      return;
    }
    setPhase("screening");
    const results = await Promise.all(
      candidates.map(async (address) => ({ address, ...(await screenDestination(address)) }))
    );
    const clean = results.filter((result) => !result.risky).map((result) => result.address);
    const flaggedResults = results
      .filter((result) => result.risky)
      .map((result) => ({ address: result.address, unavailable: result.unavailable }));
    if (clean.length > 0) commitMany(clean, "destinationAllowText");
    setFlagged((current) => [...current, ...flaggedResults]);
    setPhase("idle");
    toast.success(
      t("DashboardCustody.policyBulkAddSummary", {
        added: clean.length,
        flagged: flaggedResults.length,
      }),
      { position: "bottom-right" }
    );
  }

  function handleQueryChange(value: string) {
    const valueParsed = parseDestinationText(value);
    if (valueParsed.entries.length > 1) {
      void handleBulkPaste(valueParsed);
      return;
    }
    setQuery(value);
    setOpen(true);
    setInputError(null);
    if (phase !== "idle" && !busy) resetScreening();
  }

  function toggleAccount(address: string) {
    if (parsed.valid.includes(address)) {
      removeDestination(address);
      setQuery("");
      setOpen(false);
      return;
    }
    void requestAdd(address);
  }

  function submitSearch() {
    if (matchingAccounts.length === 1) {
      toggleAccount(matchingAccounts[0].address);
      return;
    }
    if (canAddExternal) {
      void requestAdd(trimmedQuery);
      return;
    }
    if (trimmedQuery) setInputError("invalid");
  }

  function onScreeningComplete() {
    if (hasRisk) setPhase("risk");
    else clearEntry();
  }

  /**
   * Resolves the display identity for a committed destination entry.
   *
   * @param entry - The committed destination address.
   * @returns The counterparty name when the address is known, or the external-address label.
   */
  function destinationDisplay(entry: string): { name: string; known: boolean } {
    const account = accountByAddress.get(entry);
    return account
      ? { name: account.name, known: true }
      : { name: t("DashboardCustody.policyDestinationExternal"), known: false };
  }

  return {
    parsed,
    query,
    open,
    setOpen,
    inputError,
    phase,
    busy,
    snapshot,
    screenUnavailable,
    flagged,
    matchingAccounts,
    canAddExternal,
    trimmedQuery,
    handleQueryChange,
    submitSearch,
    toggleAccount,
    requestAdd,
    removeDestination,
    commitFlagged,
    commitPending,
    dismissFlagged,
    onScreeningComplete,
    destinationDisplay,
  };
}
