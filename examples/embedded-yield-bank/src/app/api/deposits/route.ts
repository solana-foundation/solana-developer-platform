import { deposit } from "@server/embedded-yield";
import { apiErrorResponse, apiSuccessResponse } from "@server/http";
import { z } from "zod";

export const runtime = "nodejs";

const inputSchema = z.object({
  strategyId: z.string().min(1),
  amount: z.string().min(1).max(128),
});

export async function POST(request: Request) {
  try {
    const input = inputSchema.parse(await request.json());
    return apiSuccessResponse({
      movement: await deposit(input.strategyId, input.amount),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
