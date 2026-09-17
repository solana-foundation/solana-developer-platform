import "server-only";

import { ApiRequestError } from "./http";

export function assertTrustedJsonRequest(request: Request): void {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0];
  if (contentType?.trim().toLowerCase() !== "application/json") {
    throw new ApiRequestError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Content-Type must be application/json"
    );
  }

  const origin = request.headers.get("origin");
  const requestUrl = new URL(request.url);
  const host = request.headers.get("host") ?? requestUrl.host;
  const protocol =
    request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim() ??
    requestUrl.protocol.slice(0, -1);
  if (origin !== `${protocol}://${host}`) {
    throw new ApiRequestError(
      403,
      "UNTRUSTED_ORIGIN",
      "State-changing requests must come from this application"
    );
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") {
    throw new ApiRequestError(
      403,
      "UNTRUSTED_ORIGIN",
      "State-changing requests must come from this application"
    );
  }
}
