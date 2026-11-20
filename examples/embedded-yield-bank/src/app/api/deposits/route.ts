import { prepareCoreDeposit } from "@server/embedded-yield";
import {
  ApiRequestError,
  apiErrorResponse,
  apiSuccessResponse,
} from "@server/http";
import { assertTrustedJsonRequest } from "@server/request-security";
import { z } from "zod";

export const runtime = "nodejs";

const inputSchema = z.object({
  amount: z.string().min(1).max(128),
});

/** Checking to savings. */
export async function POST(request: Request) {
  try {
    assertTrustedJsonRequest(request);
    const input = inputSchema.parse(await request.json());
    const key = request.headers.get("Idempotency-Key");
    if (!key)
      throw new ApiRequestError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "Idempotency-Key is required"
      );
    return apiSuccessResponse({
      operation: await prepareCoreDeposit(input.amount, key),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
