import * as clerkSdk from "@clerk/nextjs";
import { vi } from "vitest";

type ClerkAuth = ReturnType<typeof clerkSdk.useAuth>;

/**
 * Spies on Clerk's `useAuth` and `useClerk` for a suite that renders the
 * dashboard workspace provider: a session in `org_test`, unless `auth` says
 * otherwise, whose `setActive` succeeds. Call it in `beforeEach`;
 * `vi.restoreAllMocks` undoes it.
 */
export function stubClerkSession(
  auth: Partial<Pick<ClerkAuth, "isLoaded" | "orgId" | "userId">> = {}
): void {
  vi.mocked(vi.spyOn(clerkSdk, "useAuth"), { partial: true }).mockImplementation(() => ({
    orgId: "org_test",
    userId: "user_test",
    ...auth,
  }));
  vi.mocked(vi.spyOn(clerkSdk, "useClerk"), { partial: true }).mockImplementation(() => ({
    setActive: async () => undefined,
  }));
}
