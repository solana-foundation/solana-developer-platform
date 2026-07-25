import { describe, expect, it } from "vitest";
import { describeClerkFailure } from "./clerk-error";

describe("describeClerkFailure", () => {
  it("prefers the long message Clerk writes for humans", () => {
    const body = JSON.stringify({
      errors: [
        {
          message: "duplicate record",
          long_message: "There is already a pending invitation for this email address.",
        },
      ],
    });

    expect(describeClerkFailure(422, body)).toBe(
      "Clerk request failed (422): There is already a pending invitation for this email address."
    );
  });

  it("falls back to the short message when there is no long form", () => {
    const body = JSON.stringify({ errors: [{ message: "is not a valid email address" }] });

    expect(describeClerkFailure(422, body)).toBe(
      "Clerk request failed (422): is not a valid email address"
    );
  });

  it("uses a top-level message when Clerk does not return an errors array", () => {
    expect(describeClerkFailure(401, JSON.stringify({ message: "Unauthenticated" }))).toBe(
      "Clerk request failed (401): Unauthenticated"
    );
  });

  it("keeps a non-JSON body rather than discarding it", () => {
    expect(describeClerkFailure(502, "<html>Bad Gateway</html>")).toBe(
      "Clerk request failed (502): <html>Bad Gateway</html>"
    );
  });

  it("reports the status alone when the body is empty", () => {
    expect(describeClerkFailure(500, "   ")).toBe("Clerk request failed (500)");
  });

  it("truncates an unbounded upstream body", () => {
    const message = describeClerkFailure(500, "x".repeat(1000));

    expect(message.length).toBeLessThan(360);
    expect(message.endsWith("…")).toBe(true);
  });
});

describe("describeClerkFailure truncation", () => {
  it("bounds a parsed long_message, not just a raw body", () => {
    const body = JSON.stringify({ errors: [{ long_message: "y".repeat(1000) }] });
    const message = describeClerkFailure(422, body);

    expect(message.length).toBeLessThan(360);
    expect(message.endsWith("…")).toBe(true);
  });

  it("bounds a top-level message too", () => {
    const message = describeClerkFailure(500, JSON.stringify({ message: "z".repeat(1000) }));

    expect(message.length).toBeLessThan(360);
    expect(message.endsWith("…")).toBe(true);
  });
});
