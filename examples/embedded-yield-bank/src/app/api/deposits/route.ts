import { prepareDeposit } from "@server/embedded-yield";
import { apiErrorResponse, apiSuccessResponse } from "@server/http";
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
    return apiSuccessResponse({ intent: await prepareDeposit(input.amount) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
