"use server";

import type { OrganizationRole } from "@sdp/types/roles";
import { revalidatePath } from "next/cache";
import { getTranslations } from "@/i18n/server";
import { actionIdempotencyHeaders } from "@/lib/idempotency";
import { createOrgSdpApiClient, createSdpApiClient, requestProjectHref } from "@/lib/sdp-api";
import { readableApiError } from "@/lib/sdp-api-error";

// Membership is organization-wide, so reads use the org client. Mutations go
// through the project client: their idempotency keys are scoped to a project
// (routes/members/index.ts).

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

export type MemberActionResult = { ok: true } | { ok: false; error: string };

/**
 * Runs one member mutation and refreshes the settings page it renders on.
 *
 * @param path - The members API path.
 * @param init - The request.
 * @returns The outcome, with the API's error when it refused.
 */
async function mutateMembers(path: string, init: RequestInit): Promise<MemberActionResult> {
  try {
    const client = await createSdpApiClient();
    await client.fetch(path, init);
  } catch (error) {
    return { ok: false, error: readableApiError(error) };
  }

  revalidatePath(await requestProjectHref("/dashboard/settings"));
  return { ok: true };
}

/**
 * Removes another member. A retry with the same key finishes a removal whose
 * Clerk half failed.
 *
 * @param memberId - The member to remove.
 * @param idempotencyKey - The key the browser minted for this removal.
 * @returns The outcome.
 */
export async function removeMember(
  memberId: string,
  idempotencyKey: string
): Promise<MemberActionResult> {
  return mutateMembers(`/v1/members/${encodeURIComponent(memberId)}`, {
    method: "DELETE",
    headers: actionIdempotencyHeaders(idempotencyKey),
  });
}

/**
 * Changes another member's Organization Role.
 *
 * @param memberId - The member.
 * @param role - Their new role.
 * @param idempotencyKey - The key the browser minted for this change.
 * @returns The outcome.
 */
export async function changeMemberRole(
  memberId: string,
  role: OrganizationRole,
  idempotencyKey: string
): Promise<MemberActionResult> {
  return mutateMembers(`/v1/members/${encodeURIComponent(memberId)}`, {
    method: "PATCH",
    headers: actionIdempotencyHeaders(idempotencyKey),
    body: JSON.stringify({ role }),
  });
}

/**
 * Ends the caller's own membership. Not retryable: once it commits the API
 * refuses the caller, so the page leaves the organization on success.
 *
 * @returns The outcome.
 */
export async function leaveOrganization(): Promise<MemberActionResult> {
  try {
    const client = await createSdpApiClient();
    await client.fetch("/v1/members/me", { method: "DELETE" });
  } catch (error) {
    return { ok: false, error: readableApiError(error) };
  }
  return { ok: true };
}

/**
 * Withdraws a pending invitation.
 *
 * @param invitationId - The invitation.
 * @param idempotencyKey - The key the browser minted for this revocation.
 * @returns The outcome.
 */
export async function revokeInvitation(
  invitationId: string,
  idempotencyKey: string
): Promise<MemberActionResult> {
  return mutateMembers(`/v1/members/invitations/${encodeURIComponent(invitationId)}`, {
    method: "DELETE",
    headers: actionIdempotencyHeaders(idempotencyKey),
  });
}

const MEMBERS_PAGE_SIZE = 25;

export async function listMembers(page: number): Promise<MemberDirectory> {
  const client = await createOrgSdpApiClient();
  const query = new URLSearchParams({
    page: String(Math.max(1, page)),
    pageSize: String(MEMBERS_PAGE_SIZE),
  });
  return client.fetch<MemberDirectory>(`/v1/members?${query.toString()}`);
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
      headers: actionIdempotencyHeaders(formData.get("idempotencyKey")),
      body: JSON.stringify({ email, role }),
    });
  } catch (error) {
    return { ok: false, error: readableApiError(error) };
  }

  // Members render inside the settings page; /members only redirects there.
  revalidatePath(await requestProjectHref("/dashboard/settings"));
  return { ok: true, email };
}
