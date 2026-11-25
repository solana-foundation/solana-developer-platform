import { OPERATION_KINDS, operationStatusFilterSchema } from "@sdp/types/operations";
import { z } from "zod";

/** Every lifecycle mutation names an exact prepared operation. */
export const operationIdParamsSchema = z.object({
  operationId: z.string().min(1).max(256),
});

/** Cancellation derives intent from the stored operation. */
export const emptyOperationBodySchema = z.strictObject({});

/** External history requires an explicit owner; omitted owner filters list custody operations. */
export const operationsListQuerySchema = z
  .object({
    cursor: z.string().max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    kind: z.enum(OPERATION_KINDS).optional(),
    status: operationStatusFilterSchema
      .describe(
        "One exact status, or active for every operation not yet final, preparations included."
      )
      .optional(),
    ownerAddress: z.string().min(32).max(44).optional(),
    walletId: z.string().min(1).max(256).optional(),
    positionId: z.string().min(1).max(1024).optional(),
    operationIds: z
      .string()
      .min(1)
      .max(25_699)
      .refine((value) => {
        const ids = value.split(",");
        return (
          ids.length <= 100 &&
          ids.every((id) => id.length > 0 && id.length <= 256 && !/\s/.test(id))
        );
      }, "Choose between 1 and 100 comma-separated operation IDs")
      .describe(
        "Read up to 100 known operations together. All source visibility and other filters still apply."
      )
      .optional(),
  })
  .strict()
  .refine(
    (value) => value.walletId === undefined || value.ownerAddress === undefined,
    "Choose walletId or ownerAddress"
  );
