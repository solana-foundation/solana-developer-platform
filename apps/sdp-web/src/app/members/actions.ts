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
  /** Set by the API; the client holds emails, not the actor's user id. */
  isSelf?: boolean;
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
  /** Clerk's shareable accept link; null when Clerk could not be reached. */
  acceptUrl: string | null;
}

export interface MemberDirectory {
  members: Member[];
  invitations: PendingInvitation[];
  meta: {
    total: number;
    page: number;
    pageSize: number;
    hasMore: boolean;
    activeAdminCount: number;
  };
}

export type RevokeInvitationResult = { ok: true } | { ok: false; error: string };
export type RemoveMemberResult = { ok: true } | { ok: false; error: string };

export async function removeMember(memberId: string): Promise<RemoveMemberResult> {
  try {
    const client = await createSdpApiClient();
    await client.fetch(`/v1/members/${encodeURIComponent(memberId)}`, { method: "DELETE" });
  } catch (error) {
    return { ok: false, error: readableApiError(error) };
  }

  revalidatePath("/dashboard/settings");
  return { ok: true };
}

export async function revokeInvitation(invitationId: string): Promise<RevokeInvitationResult> {
  try {
    const client = await createSdpApiClient();
    await client.fetch(`/v1/members/invitations/${encodeURIComponent(invitationId)}`, {
      method: "DELETE",
    });
  } catch (error) {
    return { ok: false, error: readableApiError(error) };
  }

  revalidatePath("/dashboard/settings");
  return { ok: true };
}

const MEMBERS_PAGE_SIZE = 25;

export async function listMembers(page = 1): Promise<MemberDirectory> {
  const client = await createSdpApiClient();
  const query = new URLSearchParams({
    page: String(Math.max(1, page)),
    pageSize: String(MEMBERS_PAGE_SIZE),
  });
  const response = await client.fetch<{
    members: Member[];
    invitations?: PendingInvitation[];
    meta?: MemberDirectory["meta"];
  }>(`/v1/members?${query.toString()}`);

  return {
    members: response.members,
    invitations: response.invitations ?? [],
    meta: response.meta ?? {
      total: response.members.length,
      page: 1,
      pageSize: MEMBERS_PAGE_SIZE,
      hasMore: false,
      activeAdminCount: response.members.filter((member) => member.role === "admin").length,
    },
  };
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
