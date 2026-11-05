"use client";

import type { RampDirection, RampProviderEstimateResult } from "@sdp/types/payments";
import type { RampProviderId } from "@sdp/types/provider-access";
import { useMemo } from "react";
import { paymentsQueryKeys } from "@/app/(session)/dashboard/[projectId]/payments/payments-query-key";
import { readRampEstimates } from "@/app/(session)/dashboard/[projectId]/payments/payments-workspace.data";
import { useTranslations } from "@/i18n/provider";
import { useDashboardKeyScope, useDashboardSWR } from "@/lib/dashboard-swr";
import type { SelectedRampPair } from "@/lib/ramps";
import { useDebounce } from "@/lib/use-debounce";

interface UseRampEstimateArgs {
  direction: RampDirection;
  selectedPair: SelectedRampPair;
  amount: string;
  enabled: boolean;
  /** Show the estimate already read for this amount, as on a review, instead of re-reading it. */
  reuseCached?: boolean;
}

interface UseRampEstimateResult {
  estimatesByProvider: Map<RampProviderId, RampProviderEstimateResult>;
  loading: boolean;
}

export function useRampEstimate({
  direction,
  selectedPair,
  amount,
  enabled,
  reuseCached = false,
}: UseRampEstimateArgs): UseRampEstimateResult {
  const t = useTranslations();
  const currentAmount = amount.trim();
  const debouncedAmount = useDebounce(currentAmount, 300);
  const hasAmount = enabled && currentAmount.length > 0 && /[1-9]/.test(currentAmount);
  const isDebouncing = currentAmount !== debouncedAmount;

  const scope = useDashboardKeyScope();
  const { data, isValidating } = useDashboardSWR(
    hasAmount && !isDebouncing
      ? paymentsQueryKeys.rampEstimate(scope, {
          direction,
          fiatCurrency: selectedPair.fiatCurrency,
          assetRail: selectedPair.assetRail,
          amount: debouncedAmount,
        })
      : null,
    (key) => readRampEstimates(key, t),
    reuseCached
      ? { keepPreviousData: false, revalidateIfStale: false, revalidateOnFocus: false }
      : { keepPreviousData: false }
  );

  const estimatesByProvider = useMemo(() => {
    const map = new Map<RampProviderId, RampProviderEstimateResult>();
    if (hasAmount && !isDebouncing && data) {
      for (const result of data) {
        map.set(result.provider, result);
      }
    }
    return map;
  }, [data, hasAmount, isDebouncing]);

  return { estimatesByProvider, loading: hasAmount && (isDebouncing || isValidating) };
}
