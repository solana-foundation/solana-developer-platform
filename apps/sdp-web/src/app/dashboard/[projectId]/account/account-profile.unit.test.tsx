// @vitest-environment jsdom

import { ClerkAPIResponseError } from "@clerk/nextjs/errors";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnglishI18n } from "@/test/i18n";
import { AccountProfile } from "./account-profile";

const PRIMARY_EMAIL_ID = "idn_test_primary";

function testEmailAddress(id: string, emailAddress: string, status: "verified" | "unverified") {
  return {
    id,
    emailAddress,
    verification: { status },
    prepareVerification: vi.fn(),
    attemptVerification: vi.fn(),
    destroy: vi.fn(),
  };
}

type TestEmailAddress = ReturnType<typeof testEmailAddress>;

function testUser(emailAddresses: TestEmailAddress[]) {
  return {
    id: "user_test_jane",
    fullName: "Jane Doe",
    firstName: "Jane",
    lastName: "Doe",
    username: null,
    hasImage: false,
    imageUrl: "",
    primaryEmailAddressId: PRIMARY_EMAIL_ID,
    emailAddresses,
    update: vi.fn(),
    createEmailAddress: vi.fn(),
    setProfileImage: vi.fn(),
  };
}

const clerk = vi.hoisted(() => {
  const state: { user: ReturnType<typeof testUser> | null } = { user: null };
  return state;
});

vi.mock("@clerk/nextjs", () => ({
  useUser: () => ({ user: clerk.user }),
  useOrganization: () => ({ organization: { id: "org_test_acme", name: "Acme" } }),
  useReverification: (action: unknown) => action,
}));
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({ dashboardAccess: { role: "admin" } }),
}));

function renderProfile(user: ReturnType<typeof testUser>) {
  clerk.user = user;
  return render(<AccountProfile />, { wrapper: EnglishI18n });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("AccountProfile email addresses", () => {
  it("offers Make primary only on a verified address that is not primary", async () => {
    const user = testUser([
      testEmailAddress(PRIMARY_EMAIL_ID, "jane@example.com", "verified"),
      testEmailAddress("idn_test_work", "jane@work.example", "verified"),
      testEmailAddress("idn_test_old", "jane@old.example", "unverified"),
    ]);
    user.update.mockResolvedValue(user);
    renderProfile(user);
    const actor = userEvent.setup();

    expect(screen.getAllByRole("button", { name: "Make primary" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Verify" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(2);

    await actor.click(screen.getByRole("button", { name: "Make primary" }));

    await waitFor(() =>
      expect(user.update).toHaveBeenCalledExactlyOnceWith({
        primaryEmailAddressId: "idn_test_work",
      })
    );
  });

  it("holds every email control while one row's request is in flight", async () => {
    const user = testUser([
      testEmailAddress(PRIMARY_EMAIL_ID, "jane@example.com", "verified"),
      testEmailAddress("idn_test_work", "jane@work.example", "verified"),
      testEmailAddress("idn_test_team", "jane@team.example", "verified"),
      testEmailAddress("idn_test_old", "jane@old.example", "unverified"),
    ]);
    const updated = Promise.withResolvers<void>();
    user.update.mockReturnValue(updated.promise);
    renderProfile(user);
    const actor = userEvent.setup();
    const controlsDisabled = () =>
      [
        ...screen.getAllByRole("button", { name: "Make primary" }),
        screen.getByRole("button", { name: "Verify" }),
        ...screen.getAllByRole("button", { name: "Remove" }),
        screen.getByRole("button", { name: "Add email" }),
      ].map((control) => control.hasAttribute("disabled"));

    await actor.click(screen.getAllByRole("button", { name: "Make primary" })[0]);

    expect(user.update).toHaveBeenCalledExactlyOnceWith({ primaryEmailAddressId: "idn_test_work" });
    expect(controlsDisabled()).toEqual([true, true, true, true, true, true]);

    updated.resolve();

    await waitFor(() =>
      expect(controlsDisabled()).toEqual([false, false, false, false, false, false, false])
    );
  });

  it("sends a code to an unverified address before asking for it", async () => {
    const unverified = testEmailAddress("idn_test_old", "jane@old.example", "unverified");
    const codeSent = Promise.withResolvers<TestEmailAddress>();
    unverified.prepareVerification.mockReturnValue(codeSent.promise);
    renderProfile(
      testUser([testEmailAddress(PRIMARY_EMAIL_ID, "jane@example.com", "verified"), unverified])
    );
    const actor = userEvent.setup();

    await actor.click(screen.getByRole("button", { name: "Verify" }));

    expect(unverified.prepareVerification).toHaveBeenCalledExactlyOnceWith({
      strategy: "email_code",
    });
    expect(screen.queryByLabelText("Enter the code sent to jane@old.example")).toBeNull();

    codeSent.resolve(unverified);

    expect(await screen.findByLabelText("Enter the code sent to jane@old.example")).toBeDefined();
  });

  it("adds an address, sends it a code, and verifies the code entered", async () => {
    const added = testEmailAddress("idn_test_new", "jane@new.example", "unverified");
    added.prepareVerification.mockResolvedValue(added);
    added.attemptVerification.mockResolvedValue(added);
    const user = testUser([testEmailAddress(PRIMARY_EMAIL_ID, "jane@example.com", "verified")]);
    user.createEmailAddress.mockResolvedValue(added);
    renderProfile(user);
    const actor = userEvent.setup();

    await actor.click(screen.getByRole("button", { name: "Add email" }));
    await actor.type(screen.getByLabelText("New email address"), "jane@new.example");
    await actor.click(screen.getByRole("button", { name: "Send code" }));

    const codeInput = await screen.findByLabelText("Enter the code sent to jane@new.example");
    expect(user.createEmailAddress).toHaveBeenCalledExactlyOnceWith({ email: "jane@new.example" });
    expect(added.prepareVerification).toHaveBeenCalledExactlyOnceWith({ strategy: "email_code" });
    expect(user.createEmailAddress.mock.invocationCallOrder[0]).toBeLessThan(
      added.prepareVerification.mock.invocationCallOrder[0]
    );
    expect(screen.queryByLabelText("New email address")).toBeNull();

    await actor.type(codeInput, "123456{Enter}");

    expect(added.attemptVerification).toHaveBeenCalledExactlyOnceWith({ code: "123456" });
    await waitFor(() =>
      expect(screen.queryByLabelText("Enter the code sent to jane@new.example")).toBeNull()
    );
  });

  it("reports a refused address by its Clerk code and keeps the add form open", async () => {
    const reportError = vi.spyOn(toast, "error");
    const user = testUser([testEmailAddress(PRIMARY_EMAIL_ID, "jane@example.com", "verified")]);
    user.createEmailAddress.mockRejectedValue(
      new ClerkAPIResponseError("Unprocessable Entity", {
        data: [{ code: "form_identifier_exists", message: "form_identifier_exists" }],
        status: 422,
      })
    );
    renderProfile(user);
    const actor = userEvent.setup();

    await actor.click(screen.getByRole("button", { name: "Add email" }));
    await actor.type(screen.getByLabelText("New email address"), "jane@taken.example");
    await actor.click(screen.getByRole("button", { name: "Send code" }));

    await waitFor(() =>
      expect(reportError).toHaveBeenCalledExactlyOnceWith("That address is already on an account.")
    );
    expect(screen.getByLabelText("New email address")).toBeDefined();
    expect(screen.queryByText(/Enter the code sent to/)).toBeNull();
  });
});
