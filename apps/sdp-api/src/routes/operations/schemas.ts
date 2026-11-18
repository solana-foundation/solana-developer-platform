import { OPERATION_KINDS, OPERATION_STATUSES } from "@sdp/types/operations";
import { z } from "zod";

/** Every lifecycle mutation names an exact prepared operation. */
export const operationIdParamsSchema = z.object({
  operationId: z.string().min(1).max(256),
});

/** Refresh and cancellation derive intent from the stored operation. */
export const emptyOperationBodySchema = z.strictObject({});

/** External history requires an explicit owner; omitted owner filters list custody operations. */
export const operationsListQuerySchema = z
  .object({
    cursor: z.string().max(2048).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    kind: z.enum(OPERATION_KINDS).optional(),
    status: z.enum(OPERATION_STATUSES).optional(),
    ownerAddress: z.string().min(32).max(44).optional(),
    walletId: z.string().min(1).max(256).optional(),
    positionId: z.string().min(1).max(1024).optional(),
  })
  .strict()
  .refine(
    (value) => value.walletId === undefined || value.ownerAddress === undefined,
    "Choose walletId or ownerAddress"
  );
