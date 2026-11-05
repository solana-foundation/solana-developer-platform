import { describe, expect, it } from "vitest";
import {
  findPublicSdpApiBaseUrl,
  findSdpApiBaseUrl,
  type SdpApiBaseUrlEnv,
} from "./sdp-api-base-url";

// Docker Compose: the web server reaches the API by its service name, a browser by localhost.
const COMPOSE_ENV: SdpApiBaseUrlEnv = {
  SDP_API_BASE_URL: "http://sdp-api:8787",
  NEXT_PUBLIC_SDP_API_BASE_URL: "http://localhost:8787/",
};

describe("findPublicSdpApiBaseUrl", () => {
  it("names the address a browser reaches, never the server's own", () => {
    expect(findSdpApiBaseUrl(COMPOSE_ENV)).toBe("http://sdp-api:8787");
    expect(findPublicSdpApiBaseUrl(COMPOSE_ENV)).toBe("http://localhost:8787");
  });

  it("names none when only the server's own address is set", () => {
    expect(findPublicSdpApiBaseUrl({ SDP_API_BASE_URL: "http://sdp-api:8787" })).toBeNull();
  });
});
