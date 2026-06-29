import { z } from "zod";
import { AppError, badRequest, badRequestParams, badRequestQuery } from "@/lib/errors";
import type { AppContext } from "../context";
import {
  createTransferBatchSchema,
  estimateTransferBatchSchema,
  listTransferBatchesQuerySchema,
  transferBatchIdParamsSchema,
} from "../schemas";

function todo(operation: string): never {
  throw new AppError(
    "BAD_REQUEST",
    `TODO: ${operation} transfer batch handler is not implemented yet`
  );
}

export async function estimateTransferBatch(c: AppContext) {
  const body = await c.req.json();
  const parsed = estimateTransferBatchSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  // TODO: resolve recipients, chunk transactions, and return fee/completion estimates.
  todo("estimate");
}

export async function createTransferBatch(c: AppContext) {
  const body = await c.req.json();
  const parsed = createTransferBatchSchema.safeParse(body);

  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  // TODO: create batch/recipient rows, build chunked transactions, custody-sign, submit, and confirm.
  todo("create");
}

export async function listTransferBatches(c: AppContext) {
  const query = listTransferBatchesQuerySchema.safeParse(c.req.query());
  if (!query.success) {
    throw badRequestQuery({
      errors: z.flattenError(query.error).fieldErrors,
    });
  }

  // TODO: list transfer batches for the authenticated org/project scope.
  todo("list");
}

export async function getTransferBatch(c: AppContext) {
  const params = transferBatchIdParamsSchema.safeParse(c.req.param());
  if (!params.success) {
    throw badRequestParams({
      errors: z.flattenError(params.error).fieldErrors,
    });
  }

  // TODO: load a transfer batch with its recipient rows and chunk transfer summaries.
  todo("get");
}
