import { z } from "zod";
import {
  earnExternalWalletPositionsQuerySchema,
  earnVaultPositionsQuerySchema,
  listEarnStrategiesQuerySchema,
} from "@/routes/earn/schemas";

const apyFilter = z
  .string()
  .max(128)
  .regex(/^\d+(\.\d+)?$/);
const optionalBoolean = z
  .enum(["true", "false"])
  .transform((value) => value === "true")
  .optional();

/** Discovery filters narrow the validated strategy catalogue. */
export const earnDiscoveryQuerySchema = listEarnStrategiesQuerySchema
  .extend({
    id: z.string().min(1).max(128).optional(),
    provider: z.string().min(1).max(128).optional(),
    depositMint: z.string().min(1).max(64).optional(),
    minApy: apyFilter.optional(),
    maxApy: apyFilter.optional(),
  })
  .strict()
  .refine(
    (query) =>
      query.minApy === undefined ||
      query.maxApy === undefined ||
      Number(query.minApy) <= Number(query.maxApy),
    {
      message: "minApy must not exceed maxApy",
      path: ["minApy"],
    }
  );

/** One optional owner filter; broad queries retain each ownership boundary. */
export const earnPositionsQuerySchema = z
  .object({
    walletId: z.string().min(1).max(128).optional(),
    ownerAddress: earnExternalWalletPositionsQuerySchema.shape.ownerAddress.optional(),
    ownerKind: z.enum(["custody", "external"]).optional(),
    limit: earnVaultPositionsQuerySchema.shape.limit,
    before: earnExternalWalletPositionsQuerySchema.shape.before,
    afterMovementIds: earnVaultPositionsQuerySchema.shape.afterMovementIds,
    includeSummary: optionalBoolean,
    includeOwnerAddresses: optionalBoolean,
    includePositions: optionalBoolean,
    discover: optionalBoolean,
  })
  .strict()
  .superRefine((query, ctx) => {
    if (query.discover && !query.walletId && !query.ownerAddress) {
      ctx.addIssue({
        code: "custom",
        path: ["discover"],
        message: "Position discovery requires walletId or ownerAddress",
      });
    }
    if (query.walletId && query.ownerAddress) {
      ctx.addIssue({
        code: "custom",
        path: ["walletId"],
        message: "Choose walletId or ownerAddress",
      });
    }
    if (
      (query.walletId && query.ownerKind === "external") ||
      (query.ownerAddress && query.ownerKind === "custody")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["ownerKind"],
        message: "ownerKind must match the selected owner",
      });
    }
    if ((query.includeOwnerAddresses || query.includePositions) && !query.includeSummary) {
      ctx.addIssue({
        code: "custom",
        path: ["includeSummary"],
        message: "Summary options require includeSummary=true",
      });
    }
    if (query.includePositions && !query.includeOwnerAddresses) {
      ctx.addIssue({
        code: "custom",
        path: ["includePositions"],
        message: "includePositions requires includeOwnerAddresses=true",
      });
    }
  });
