import { describe, expect, it } from "vitest";
import { getAccessCredentials, hasValidBasicAuthorization } from "./basic-auth";

describe("Northstar access protection", () => {
  const credentials = { username: "northstar", password: "secret:phrase" };

  it("accepts the configured HTTP Basic credentials", () => {
    const value = Buffer.from("northstar:secret:phrase").toString("base64");
    expect(hasValidBasicAuthorization(`Basic ${value}`, credentials)).toBe(
      true
    );
  });

  it("rejects missing, malformed, and incorrect credentials", () => {
    const wrong = Buffer.from("northstar:wrong").toString("base64");
    expect(hasValidBasicAuthorization(null, credentials)).toBe(false);
    expect(hasValidBasicAuthorization("Bearer token", credentials)).toBe(false);
    expect(hasValidBasicAuthorization(`Basic ${wrong}`, credentials)).toBe(
      false
    );
  });

  it("fails closed when no access password is configured", () => {
    expect(getAccessCredentials({})).toBeUndefined();
    expect(getAccessCredentials({ DEMO_ACCESS_PASSWORD: "secret" })).toEqual({
      username: "northstar",
      password: "secret",
    });
  });
});
