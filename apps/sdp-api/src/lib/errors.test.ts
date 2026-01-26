/**
 * Error handling tests
 */

import { describe, expect, it } from "vitest";
import { AppError, badRequest, notFound, rateLimited, unauthorized } from "./errors";

describe("AppError", () => {
  it("creates error with default message", () => {
    const error = new AppError("BAD_REQUEST");
    expect(error.message).toBe("Invalid request");
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.statusCode).toBe(400);
  });

  it("creates error with custom message", () => {
    const error = new AppError("BAD_REQUEST", "Custom message");
    expect(error.message).toBe("Custom message");
  });

  it("includes details when provided", () => {
    const error = new AppError("BAD_REQUEST", "Error", { field: "email" });
    expect(error.details).toEqual({ field: "email" });
  });

  it("converts to response format", () => {
    const error = new AppError("UNAUTHORIZED", "No token");
    const response = error.toResponse();

    expect(response).toEqual({
      error: {
        code: "UNAUTHORIZED",
        message: "No token",
      },
    });
  });

  it("includes details in response", () => {
    const error = new AppError("BAD_REQUEST", "Invalid", { errors: ["a", "b"] });
    const response = error.toResponse();

    expect(response.error.details).toEqual({ errors: ["a", "b"] });
  });
});

describe("error helper functions", () => {
  it("badRequest creates 400 error", () => {
    const error = badRequest("Invalid input");
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe("BAD_REQUEST");
  });

  it("unauthorized creates 401 error", () => {
    const error = unauthorized();
    expect(error.statusCode).toBe(401);
    expect(error.code).toBe("UNAUTHORIZED");
  });

  it("notFound creates 404 error with resource name", () => {
    const error = notFound("Organization");
    expect(error.statusCode).toBe(404);
    expect(error.message).toBe("Organization not found");
  });

  it("rateLimited creates 429 error", () => {
    const error = rateLimited();
    expect(error.statusCode).toBe(429);
    expect(error.code).toBe("RATE_LIMITED");
  });
});
