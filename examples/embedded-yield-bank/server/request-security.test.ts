import { describe, expect, it } from "vitest";
import { assertTrustedJsonRequest } from "./request-security";

const route = "https://northstar.example/api/deposits";

describe("state-changing request protection", () => {
  it("accepts same-origin JSON requests", () => {
    const request = post({
      "content-type": "application/json; charset=utf-8",
      origin: "https://northstar.example",
      "sec-fetch-site": "same-origin",
    });

    expect(() => assertTrustedJsonRequest(request)).not.toThrow();
  });

  it("uses proxy protocol and host headers for the public origin", () => {
    const request = new Request("http://localhost:3000/api/deposits", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "northstar.example",
        origin: "https://northstar.example",
        "x-forwarded-proto": "https",
      },
      body: "{}",
    });

    expect(() => assertTrustedJsonRequest(request)).not.toThrow();
  });

  it("rejects cross-origin requests", () => {
    const request = post({
      "content-type": "application/json",
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    });

    expect(() => assertTrustedJsonRequest(request)).toThrowError(
      expect.objectContaining({ status: 403, code: "UNTRUSTED_ORIGIN" })
    );
  });

  it("rejects requests without a browser origin", () => {
    const request = post({ "content-type": "application/json" });

    expect(() => assertTrustedJsonRequest(request)).toThrowError(
      expect.objectContaining({ status: 403, code: "UNTRUSTED_ORIGIN" })
    );
  });

  it("rejects CORS-simple content types", () => {
    const request = post({
      "content-type": "text/plain",
      origin: "https://northstar.example",
    });

    expect(() => assertTrustedJsonRequest(request)).toThrowError(
      expect.objectContaining({ status: 415, code: "UNSUPPORTED_MEDIA_TYPE" })
    );
  });
});

function post(headers: HeadersInit): Request {
  return new Request(route, { method: "POST", headers, body: "{}" });
}
