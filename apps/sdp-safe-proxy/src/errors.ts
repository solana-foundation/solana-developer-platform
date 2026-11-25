import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

function httpError(status: ContentfulStatusCode, error: string): HTTPException {
  return new HTTPException(status, { message: error, res: Response.json({ error }, { status }) });
}

export const unauthorized = () => httpError(401, "unauthorized");
export const forbidden = (error: string) => httpError(403, error);
export const notFound = () => httpError(404, "not_found");
export const payloadTooLarge = () => httpError(413, "payload_too_large");
export const badGateway = () => httpError(502, "provider_unreachable");
export const serviceUnavailable = () => httpError(503, "caller_check_unavailable");
