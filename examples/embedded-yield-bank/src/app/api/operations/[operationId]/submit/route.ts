import { submitCoreOperation } from "@server/embedded-yield";
import { apiErrorResponse, apiSuccessResponse } from "@server/http";
import { assertTrustedJsonRequest } from "@server/request-security";
import { z } from "zod";

const schema = z.strictObject({
  actionId: z.string().min(1).max(256),
  version: z.number().int().positive(),
  idempotencyKey: z.string().min(1).max(255),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ operationId: string }> }
) {
  try {
    assertTrustedJsonRequest(request);
    const action = schema.parse(await request.json());
    const { operationId } = await params;
    return apiSuccessResponse({
      operation: await submitCoreOperation(operationId, action),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
