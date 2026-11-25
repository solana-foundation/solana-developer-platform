import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

function httpError(status: ContentfulStatusCode, name: string): HTTPException {
  const error = `sdp_safe_proxy_${name}`;
  return new HTTPException(status, { message: error, res: Response.json({ error }, { status }) });
}

export const unauthorized = () => httpError(401, "unauthorized");
export const forbidden = (name: string) => httpError(403, name);
export const notFound = () => httpError(404, "not_found");
export const payloadTooLarge = () => httpError(413, "payload_too_large");
export const badGateway = () => httpError(502, "provider_unreachable");
export const serviceUnavailable = () => httpError(503, "caller_check_unavailable");
export const internal = () => httpError(500, "internal");
