import { z } from "zod";

/**
 * Wire shape of `GET https://api.kamino.finance/kvaults/vaults/{vault}/allocations`,
 * condensed to the figures the Treasury Solutions "Information" column shows:
 * one weight per lending market, the idle share, and the provider's timestamp.
 *
 * This module carries no directive on purpose: the BFF route
 * (`src/app/api/dashboard/markets/earn/kamino-allocations`) parses the upstream
 * response with it server-side, and the SWR hook re-parses the BFF's batched
 * response with the same schema client-side, so the two can never disagree
 * about what a well-formed allocation read is. Percent fields (`actualPct`,
 * `unallocated.pct`) arrive in PERCENT units ("23.94" = 23.94%) as decimal
 * strings, the same money-as-string posture every Earn surface keeps.
 *
 * Upstream carries far more per reserve (supplied amounts, APYs, caps,
 * collateral); none of it is kept. The disclosure is a weight list, and the
 * contract stays as small as the cell it feeds.
 *
 * A payload that does not match is a failed read, never a partial guess: the
 * cell degrades to the shared placeholder rather than inventing a figure.
 */
const decimalString = z.string();

const kaminoVaultAllocationSchema = z.object({
  reserve: z.string().min(1),
  marketName: z.string().min(1),
  actualPct: decimalString,
});

export const kaminoVaultAllocationsSchema = z.object({
  asOf: z.string().optional(),
  allocations: z.array(kaminoVaultAllocationSchema),
  unallocated: z
    .object({
      pct: decimalString.optional(),
    })
    .optional(),
});

/** The most vaults one batched read names (one catalogue page); the hook splits a longer list. */
export const KAMINO_ALLOCATIONS_MAX_VAULTS = 100;

/**
 * The batched BFF body: one parsed read per vault, keyed by vault address. A
 * vault the catalogue does not front, or whose upstream read failed, is simply
 * absent, so a refusal and an outage look the same to the browser and every
 * absent vault renders the placeholder.
 */
export const kaminoVaultAllocationsBatchSchema = z.object({
  vaults: z.record(z.string(), kaminoVaultAllocationsSchema),
});

export type KaminoVaultAllocation = z.infer<typeof kaminoVaultAllocationSchema>;
export type KaminoVaultAllocations = z.infer<typeof kaminoVaultAllocationsSchema>;
export type KaminoVaultAllocationsBatch = z.infer<typeof kaminoVaultAllocationsBatchSchema>;
