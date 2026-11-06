import { errorResponseSchema } from "@/openapi/schemas/base";
import { earnNotImplementedErrorResponseSchema } from "@/openapi/schemas/earn";
import { errorResponses, jsonContent } from "./helpers";

/** Earn's 501 comes from the SDK and has its own error code. */
export function earnErrorResponses(codes: number[]) {
  const responses = errorResponses(errorResponseSchema, codes);
  if (codes.includes(501)) {
    responses[501] = {
      description: "The provider does not support this operation.",
      content: jsonContent(earnNotImplementedErrorResponseSchema),
    };
  }
  return responses;
}
