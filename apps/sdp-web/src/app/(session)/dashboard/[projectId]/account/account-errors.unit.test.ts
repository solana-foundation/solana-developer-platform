// @vitest-environment jsdom

import { ClerkAPIResponseError, ClerkRuntimeError } from "@clerk/nextjs/errors";
import { cleanup, renderHook } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnglishI18n } from "@/test/i18n";
import { useReportAccountError } from "./account-errors";

const GENERIC_MESSAGE = "That didn’t work. Try again.";

function clerkApiError(codes: readonly string[]) {
  return new ClerkAPIResponseError("Unprocessable Entity", {
    data: codes.map((code) => ({ code, message: code })),
    status: 422,
  });
}

function reportError(error: unknown) {
  const { result } = renderHook(() => useReportAccountError(), { wrapper: EnglishI18n });
  result.current(error);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("useReportAccountError", () => {
  it.each([
    [
      "a known Clerk code",
      clerkApiError(["form_code_incorrect"]),
      "That code is not the one we sent. Check the latest email.",
    ],
    [
      "the first of several codes",
      clerkApiError(["form_password_pwned", "form_code_incorrect"]),
      "That password has appeared in a data breach. Choose another.",
    ],
    ["an unknown Clerk code", clerkApiError(["form_unknown_test"]), GENERIC_MESSAGE],
    ["a Clerk response with no errors", clerkApiError([]), GENERIC_MESSAGE],
    [
      "another Clerk runtime error",
      new ClerkRuntimeError("Timeout waiting for Clerk to load.", {
        code: "clerk_runtime_load_timeout",
      }),
      GENERIC_MESSAGE,
    ],
    ["a plain Error", new Error("network down"), GENERIC_MESSAGE],
  ])("toasts %s by its message", (_case, error, message) => {
    const toastError = vi.spyOn(toast, "error");

    reportError(error);

    expect(toastError).toHaveBeenCalledExactlyOnceWith(message);
  });

  it("says nothing when the person cancels the reverification", () => {
    const toastError = vi.spyOn(toast, "error");

    reportError(
      new ClerkRuntimeError("User cancelled attempted verification", {
        code: "reverification_cancelled",
      })
    );

    expect(toastError).not.toHaveBeenCalled();
  });
});
