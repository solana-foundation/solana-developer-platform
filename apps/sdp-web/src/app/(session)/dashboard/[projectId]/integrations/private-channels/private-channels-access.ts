import { auth } from "@clerk/nextjs/server";
import { notFound, redirect } from "next/navigation";
import { privateChannels } from "@/flags";
import { getAuthEntryPath } from "@/lib/auth-entry";

/**
 * Flag + auth gate shared by every Private Channels page.
 *
 * The flag check runs first so a hand-typed URL 404s without spending an
 * authenticated round trip, matching the segment layout's ordering. Both
 * `notFound()` and `redirect()` throw, so callers can treat a normal return as
 * "the caller is allowed to render".
 */
export async function requirePrivateChannelsAccess(): Promise<void> {
  if (!(await privateChannels())) {
    notFound();
  }

  const { userId, orgId } = await auth();
  if (!userId) {
    redirect(await getAuthEntryPath());
  }
  if (!orgId) {
    redirect("/dashboard");
  }
}
