import { cancelQueuedWithdrawal } from "@server/embedded-yield";
import { apiErrorResponse, apiSuccessResponse } from "@server/http";
import { assertTrustedJsonRequest } from "@server/request-security";
import { z } from "zod";

export const runtime = "nodejs";

const inputSchema = z
  .object({ withdrawalRequestId: z.string().min(1).max(128) })
  .strict();

/** Recover shares from a queued request after its solver deadline. */
export async function POST(request: Request) {
  try {
    assertTrustedJsonRequest(request);
    const input = inputSchema.parse(await request.json());
    return apiSuccessResponse({
      withdrawalRequest: await cancelQueuedWithdrawal(
        input.withdrawalRequestId
      ),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
