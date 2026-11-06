import type { UserResource } from "@clerk/nextjs/types";

export function userDisplayName(user: UserResource): string | undefined {
  const joinedName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return user.fullName || joinedName || user.username || user.primaryEmailAddress?.emailAddress;
}
