import { withdraw } from "@server/embedded-yield";
import { apiErrorResponse, apiSuccessResponse } from "@server/http";
import { assertTrustedJsonRequest } from "@server/request-security";
import { z } from "zod";

export const runtime = "nodejs";

const inputSchema = z.discriminatedUnion("route", [
  z.strictObject({
    amount: z.string().min(1).max(128),
    route: z.literal("direct"),
  }),
  z.strictObject({
    amount: z.string().min(1).max(128),
    route: z.literal("queued"),
    discountBps: z.number().int().min(0).max(10_000),
    deadlineSeconds: z.number().int().positive().max(7_776_000),
  }),
]);

/** Savings to checking. */
export async function POST(request: Request) {
  try {
    assertTrustedJsonRequest(request);
    const input = inputSchema.parse(await request.json());
    return apiSuccessResponse(await withdraw(input));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
