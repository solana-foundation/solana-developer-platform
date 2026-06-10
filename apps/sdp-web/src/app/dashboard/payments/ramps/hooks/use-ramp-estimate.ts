"use client";

import type { RampDirection, RampProviderEstimateResult } from "@sdp/types";
import type { RampProviderId } from "@sdp/types/provider-access";
import { useMemo } from "react";
import useSWR from "swr";
import type { SelectedRampPair } from "@/lib/ramps";
import { useDebounce } from "@/lib/use-debounce";
import { fetchRampEstimates } from "../../payments-workspace.data";

interface UseRampEstimateArgs {
  direction: RampDirection;
  selectedPair: SelectedRampPair;
  amount: string;
  enabled: boolean;
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
}: UseRampEstimateArgs): UseRampEstimateResult {
  const debouncedAmount = useDebounce(amount.trim(), 300);
  const hasAmount = enabled && debouncedAmount.length > 0 && /[1-9]/.test(debouncedAmount);

  const { data, isValidating } = useSWR(
    hasAmount
      ? ([
          "ramp-estimate",
          direction,
          selectedPair.fiatCurrency,
          selectedPair.assetRail,
          debouncedAmount,
        ] as const)
      : null,
    () =>
      fetchRampEstimates({
        direction,
        assetRail: selectedPair.assetRail,
        fiatCurrency: selectedPair.fiatCurrency,
        amount: debouncedAmount,
      }),
    { keepPreviousData: true }
  );

  const estimatesByProvider = useMemo(() => {
    const map = new Map<RampProviderId, RampProviderEstimateResult>();
    if (hasAmount && data) {
      for (const result of data) {
        map.set(result.provider, result);
      }
    }
    return map;
  }, [data, hasAmount]);

  return { estimatesByProvider, loading: isValidating };
}
