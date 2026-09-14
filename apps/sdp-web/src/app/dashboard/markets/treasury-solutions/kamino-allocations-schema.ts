import { z } from "zod";

/**
 * Wire shape of `GET https://api.kamino.finance/kvaults/vaults/{vault}/allocations`,
 * condensed to the figures the Treasury Solutions "Information" column shows.
 *
 * This module carries no directive on purpose: the BFF route
 * (`src/app/api/dashboard/markets/earn/kamino-allocations`) parses the upstream
 * response with it server-side, and the SWR hook re-parses the BFF response
 * with the same schema client-side, so the two can never disagree about what a
 * well-formed allocation read is. Percent fields (`targetWeightPct`,
 * `actualPct`, `unallocated.pct`) arrive in PERCENT units ("23.94" = 23.94%);
 * APY fields are decimal fractions ("0.0449" = 4.49%); USD fields are decimal
 * strings, the same money-as-string posture every Earn surface keeps.
 *
 * A payload that does not match is a failed read, never a partial guess: the
 * cell degrades to the shared placeholder rather than inventing a figure.
 */
const decimalString = z.string();

export const kaminoVaultAllocationSchema = z.object({
  reserve: z.string().min(1),
  marketName: z.string().min(1),
  symbol: z.string().min(1),
  targetWeightPct: decimalString.optional(),
  actualPct: decimalString,
  suppliedUsd: decimalString.optional(),
  supplyApy: decimalString.optional(),
  rewardsApy: decimalString.optional(),
});

export const kaminoVaultAllocationsSchema = z.object({
  asOf: z.string().optional(),
  capitalDeployedUsd: decimalString.optional(),
  allocations: z.array(kaminoVaultAllocationSchema),
  unallocated: z
    .object({
      usd: decimalString.optional(),
      pct: decimalString.optional(),
    })
    .optional(),
});

export type KaminoVaultAllocation = z.infer<typeof kaminoVaultAllocationSchema>;
export type KaminoVaultAllocations = z.infer<typeof kaminoVaultAllocationsSchema>;
