import { prepareQueuedWithdrawalCancellation } from "@server/embedded-yield";
import { apiErrorResponse, apiSuccessResponse } from "@server/http";
import { assertTrustedJsonRequest } from "@server/request-security";
import { z } from "zod";

export const runtime = "nodejs";

const inputSchema = z.strictObject({
  withdrawalRequestId: z.string().min(1).max(128),
});

/** Recover shares from a queued request after its solver deadline. */
export async function POST(request: Request) {
  try {
    assertTrustedJsonRequest(request);
    const input = inputSchema.parse(await request.json());
    return apiSuccessResponse({
      intent: await prepareQueuedWithdrawalCancellation(
        input.withdrawalRequestId
      ),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
