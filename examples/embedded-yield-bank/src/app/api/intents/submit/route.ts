import { submitPreparedIntent } from "@server/embedded-yield";
import { apiErrorResponse, apiSuccessResponse } from "@server/http";
import { assertTrustedJsonRequest } from "@server/request-security";
import { preparedIntentSchema } from "@/lib/prepared-intent";

export const runtime = "nodejs";

/** Replayable submit. SDP verifies the scoped build, full message and signatures. */
export async function POST(request: Request) {
  try {
    assertTrustedJsonRequest(request);
    const intent = preparedIntentSchema.parse(await request.json());
    return apiSuccessResponse(await submitPreparedIntent(intent));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
