"use server";

import { MEMBER_STATUSES } from "@sdp/types/organizations";
import { ORGANIZATION_ROLES, type OrganizationRole } from "@sdp/types/roles";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getTranslations } from "@/i18n/server";
import { type ApiAnswer, IDEMPOTENCY_KEY_HEADER, IDEMPOTENCY_KEY_PATTERN } from "@/lib/idempotency";
import {
  createOrgSdpApiClient,
  createSdpApiClient,
  requestProjectHref,
  sdpApiAnswer,
} from "@/lib/sdp-api";
import { readableApiError } from "@/lib/sdp-api-error";

// Membership is organization-wide, so reads use the org client. Mutations go
// through the project client: their idempotency keys are scoped to a project
// (routes/members/index.ts).

const memberSchema = z.object({
  id: z.string(),
  role: z.enum(ORGANIZATION_ROLES),
  status: z.enum(MEMBER_STATUSES),
  createdAt: z.string(),
  /** Set by the API; the client holds emails, not the actor's user id. */
  isSelf: z.boolean(),
  user: z.object({ id: z.string(), email: z.string(), name: z.string().nullable() }),
});

const pendingInvitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(ORGANIZATION_ROLES),
  status: z.literal("pending"),
  createdAt: z.string(),
  expiresAt: z.string(),
  /** Clerk's shareable accept link; null when Clerk could not be reached. */
  acceptUrl: z.string().nullable(),
});

const memberDirectorySchema = z.object({
  members: z.array(memberSchema),
  invitations: z.array(pendingInvitationSchema),
  meta: z.object({
    total: z.number(),
    page: z.number(),
    pageSize: z.number(),
    hasMore: z.boolean(),
    activeAdminCount: z.number(),
  }),
});

export type Member = z.infer<typeof memberSchema>;
export type PendingInvitation = z.infer<typeof pendingInvitationSchema>;
export type MemberDirectory = z.infer<typeof memberDirectorySchema>;

/** What a member action reports, in the shape `useActionIdempotencyKey` settles. */
export type MemberActionResult =
  | { status: "success" }
  | { status: "error"; message: string; answer: ApiAnswer };

const idSchema = z.string().min(1).max(200);
const idempotencyKeySchema = z.string().regex(IDEMPOTENCY_KEY_PATTERN);

/**
 * Runs one member mutation and refreshes the settings page it renders on.
 *
 * @param path - The members API path.
 * @param init - The request.
 * @returns The outcome, with what sdp-api answered when it refused.
 */
async function mutateMembers(path: string, init: RequestInit): Promise<MemberActionResult> {
  try {
    const client = await createSdpApiClient();
    await client.fetch(path, init);
  } catch (error) {
    return { status: "error", message: readableApiError(error), answer: sdpApiAnswer(error) };
  }

  revalidatePath(await requestProjectHref("/dashboard/settings"));
  return { status: "success" };
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
  const input = z
    .object({ memberId: idSchema, idempotencyKey: idempotencyKeySchema })
    .parse({ memberId, idempotencyKey });
  return mutateMembers(`/v1/members/${encodeURIComponent(input.memberId)}`, {
    method: "DELETE",
    headers: { [IDEMPOTENCY_KEY_HEADER]: input.idempotencyKey },
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
  const input = z
    .object({
      memberId: idSchema,
      role: z.enum(ORGANIZATION_ROLES),
      idempotencyKey: idempotencyKeySchema,
    })
    .parse({ memberId, role, idempotencyKey });
  return mutateMembers(`/v1/members/${encodeURIComponent(input.memberId)}`, {
    method: "PATCH",
    headers: { [IDEMPOTENCY_KEY_HEADER]: input.idempotencyKey },
    body: JSON.stringify({ role: input.role }),
  });
}

/**
 * Ends the caller's own membership. Not retryable: once it commits the API
 * refuses the caller, so the page leaves the organization even when the
 * request reports a failure after the membership ended.
 *
 * @returns The outcome.
 */
export async function leaveOrganization(): Promise<MemberActionResult> {
  try {
    const client = await createSdpApiClient();
    await client.fetch("/v1/members/me", { method: "DELETE" });
  } catch (error) {
    return { status: "error", message: readableApiError(error), answer: sdpApiAnswer(error) };
  }
  return { status: "success" };
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
  const input = z
    .object({ invitationId: idSchema, idempotencyKey: idempotencyKeySchema })
    .parse({ invitationId, idempotencyKey });
  return mutateMembers(`/v1/members/invitations/${encodeURIComponent(input.invitationId)}`, {
    method: "DELETE",
    headers: { [IDEMPOTENCY_KEY_HEADER]: input.idempotencyKey },
  });
}

const MEMBERS_PAGE_SIZE = 25;

export async function listMembers(page: number): Promise<MemberDirectory> {
  const client = await createOrgSdpApiClient();
  const query = new URLSearchParams({
    page: String(Math.max(1, page)),
    pageSize: String(MEMBERS_PAGE_SIZE),
  });
  return memberDirectorySchema.parse(
    await client.fetch<unknown>(`/v1/members?${query.toString()}`)
  );
}

export type InviteMemberResult =
  | { status: "success"; email: string }
  | { status: "error"; message: string; answer?: ApiAnswer };

const inviteFormSchema = z.object({
  email: z.string().trim().toLowerCase().min(1),
  role: z.enum(ORGANIZATION_ROLES),
  idempotencyKey: idempotencyKeySchema,
});

/**
 * Returns the failure instead of throwing so the form can render it inline. A
 * thrown server action surfaces as an error boundary, which discards the
 * typed-in address and tells the user nothing actionable.
 *
 * @param formData - The invite form: `email`, `role` and the browser's `idempotencyKey`.
 * @returns The outcome, with what sdp-api answered when it refused.
 */
export async function inviteMember(formData: FormData): Promise<InviteMemberResult> {
  const t = await getTranslations();
  const parsed = inviteFormSchema.safeParse({
    email: formData.get("email"),
    role: formData.get("role"),
    idempotencyKey: formData.get("idempotencyKey"),
  });
  if (!parsed.success) {
    return { status: "error", message: t("Shared.members.emailRequired") };
  }

  try {
    const client = await createSdpApiClient();
    await client.fetch("/v1/members/invite", {
      method: "POST",
      headers: { [IDEMPOTENCY_KEY_HEADER]: parsed.data.idempotencyKey },
      body: JSON.stringify({ email: parsed.data.email, role: parsed.data.role }),
    });
  } catch (error) {
    return { status: "error", message: readableApiError(error), answer: sdpApiAnswer(error) };
  }

  // Members render inside the settings page; /members only redirects there.
  revalidatePath(await requestProjectHref("/dashboard/settings"));
  return { status: "success", email: parsed.data.email };
}
