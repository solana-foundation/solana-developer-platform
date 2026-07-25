"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "@/i18n/server";
import { createSdpApiClient } from "@/lib/sdp-api";
import { readableApiError } from "@/lib/sdp-api-error";

// createSdpApiClient is project-scoped rather than org-scoped on purpose:
// /v1/members applies projectContextMiddleware to every route
// (routes/members/index.ts), so it rejects a request without an x-project-id
// header even though membership itself is organization-level.

export interface Member {
  id: string;
  role: string;
  status: string;
  createdAt: string;
  user: {
    id: string;
    email: string;
    name: string | null;
  };
}

export interface PendingInvitation {
  id: string;
  email: string;
  role: string;
  status: string;
  createdAt: string;
  expiresAt: string;
}

export interface MemberDirectory {
  members: Member[];
  invitations: PendingInvitation[];
}

export async function listMembers(): Promise<MemberDirectory> {
  const client = await createSdpApiClient();
  const response = await client.fetch<{
    members: Member[];
    invitations?: PendingInvitation[];
  }>("/v1/members");

  return { members: response.members, invitations: response.invitations ?? [] };
}

export type InviteMemberResult = { ok: true; email: string } | { ok: false; error: string };

/**
 * Returns the failure instead of throwing so the form can render it inline. A
 * thrown server action surfaces as an error boundary, which discards the
 * typed-in address and tells the user nothing actionable.
 */
export async function inviteMember(formData: FormData): Promise<InviteMemberResult> {
  const t = await getTranslations();
  const email = String(formData.get("email") ?? "").trim();
  const role = String(formData.get("role") ?? "member").trim();

  if (!email) {
    return { ok: false, error: t("Shared.members.emailRequired") };
  }

  try {
    const client = await createSdpApiClient();
    await client.fetch("/v1/members/invite", {
      method: "POST",
      body: JSON.stringify({ email, role }),
    });
  } catch (error) {
    return { ok: false, error: readableApiError(error) };
  }

  // Members render inside the settings page; /members only redirects there.
  revalidatePath("/dashboard/settings");
  return { ok: true, email };
}
