import { z } from "zod";
import { AppError } from "@/lib/errors";
import { logVendorCallFailure } from "@/runtime/vendor-calls";
import type { Env } from "@/types/env";
import { ClerkRequestError, describeClerkFailure } from "./clerk-error";

/** Clerk's code for an invitation to an address already a member of the organization. */
const CLERK_ALREADY_A_MEMBER = "already_a_member_in_organization";

export interface ClerkOrganizationInvitation {
  id: string;
  email_address: string;
  role: string;
  status: string;
  created_at?: number;
  /** Shareable accept link Clerk mints; the only copy that exists. */
  url?: string;
  /** Clerk's own record of who sent it — a valid Clerk user by construction. */
  inviter_id?: string;
}

export interface ClerkOrganization {
  id: string;
  name?: string;
  slug?: string | null;
  private_metadata?: Record<string, unknown> | null;
}

/** The SDP invitation id `createOrganizationInvitation` stores on each Clerk invitation. */
const sdpTaggedInvitationsSchema = z.array(
  z.object({
    id: z.string(),
    private_metadata: z.object({ sdpInvitationId: z.string().optional() }).nullable().optional(),
  })
);

const clerkOrganizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string().nullable(),
  private_metadata: z.record(z.string(), z.unknown()).nullable(),
});

/**
 * Bounds every Backend API call: organization creation holds a row lock across
 * its Clerk calls, so a hung one must fail rather than hold the connection.
 */
const CLERK_REQUEST_TIMEOUT_MS = 10_000;

export class ClerkOrganizationsService {
  private apiBase: string;
  private secretKey: string;

  constructor(env: Env) {
    if (!env.CLERK_SECRET_KEY) {
      throw new AppError("INTERNAL_ERROR", "CLERK_SECRET_KEY is required");
    }
    this.secretKey = env.CLERK_SECRET_KEY;
    this.apiBase = env.CLERK_API_URL?.replace(/\/$/, "") || "https://api.clerk.com/v1";
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const operation = `${options.method ?? "GET"} ${path.split("?")[0]}`;
    const startedAt = Date.now();
    const res = await fetch(`${this.apiBase}${path}`, {
      ...options,
      signal: AbortSignal.timeout(CLERK_REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    }).catch((error: unknown) => {
      logVendorCallFailure("clerk", operation, error, startedAt);
      throw error;
    });

    if (!res.ok) {
      const body = await res.text().catch((error: unknown) => {
        logVendorCallFailure("clerk", operation, error, startedAt);
        throw error;
      });
      logVendorCallFailure(
        "clerk",
        operation,
        new Error(describeClerkFailure(res.status, body)),
        startedAt
      );
      throw new ClerkRequestError(res.status, body);
    }

    if (res.status === 204) {
      return {} as T;
    }

    return (await res.json().catch((error: unknown) => {
      logVendorCallFailure("clerk", operation, error, startedAt);
      throw error;
    })) as T;
  }

  /**
   * Invites an address to the Clerk organization as `org:member`, naming no
   * inviter: SDP holds the person's real role (ADR 0012), and Clerk checks a
   * named inviter's own permissions, which no `org:member` has.
   *
   * @param params.organizationId - The Clerk organization id.
   * @param params.emailAddress - The address to invite.
   * @param params.expiresInDays - How long Clerk's link lives; matches the SDP invitation.
   * @param params.redirectUrl - Where Clerk's link lands: the dashboard's sign-in page.
   * @param params.sdpInvitationId - The SDP invitation it delivers, stored on it so a call
   *   that failed without returning its id can still find exactly this invitation.
   * @returns The Clerk invitation.
   */
  async createOrganizationInvitation(params: {
    organizationId: string;
    emailAddress: string;
    expiresInDays: number;
    redirectUrl: string;
    sdpInvitationId: string;
  }): Promise<ClerkOrganizationInvitation> {
    const payload = {
      email_address: params.emailAddress,
      role: "org:member",
      expires_in_days: params.expiresInDays,
      redirect_url: params.redirectUrl,
      private_metadata: { sdpInvitationId: params.sdpInvitationId },
    };

    return this.request<ClerkOrganizationInvitation>(
      `/organizations/${params.organizationId}/invitations`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      }
    );
  }

  /**
   * The same invitation, or null when Clerk refuses it because the address is
   * already a member of the Clerk organization. The caller decides what that
   * membership means; Clerk's refusal for it is the one this interprets.
   *
   * @param params - As for {@link createOrganizationInvitation}.
   * @returns The Clerk invitation, or null for an address already a member.
   */
  async createOrganizationInvitationUnlessMember(
    params: Parameters<ClerkOrganizationsService["createOrganizationInvitation"]>[0]
  ): Promise<ClerkOrganizationInvitation | null> {
    try {
      return await this.createOrganizationInvitation(params);
    } catch (error) {
      if (error instanceof ClerkRequestError && error.clerkCode === CLERK_ALREADY_A_MEMBER) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Every pending invitation, following pagination.
   *
   * A single capped page is not safe here: revocation matches against this
   * list, so an invitation beyond the cap would be reported as absent and its
   * acceptance link would stay live.
   */
  async listPendingOrganizationInvitations(
    organizationId: string
  ): Promise<ClerkOrganizationInvitation[]> {
    const pageSize = 100;
    const all: ClerkOrganizationInvitation[] = [];

    for (let offset = 0; ; offset += pageSize) {
      const response = await this.request<
        { data?: ClerkOrganizationInvitation[] } | ClerkOrganizationInvitation[]
      >(
        `/organizations/${organizationId}/invitations?status=pending&limit=${pageSize}&offset=${offset}`
      );

      // Clerk has returned both a bare array and a { data } envelope across
      // versions, so accept either rather than depending on the current shape.
      const page = Array.isArray(response) ? response : (response.data ?? []);
      all.push(...page);

      if (page.length < pageSize) {
        return all;
      }
    }
  }

  /**
   * Every pending invitation that carries the SDP invitation id
   * `createOrganizationInvitation` stores on it, so a create whose answer never
   * arrived can still be traced to its SDP invitation.
   */
  async listSdpTaggedPendingInvitations(
    organizationId: string
  ): Promise<Array<{ clerkInvitationId: string; sdpInvitationId: string }>> {
    const pending = sdpTaggedInvitationsSchema.parse(
      await this.listPendingOrganizationInvitations(organizationId)
    );
    return pending.flatMap((invitation) => {
      const sdpInvitationId = invitation.private_metadata?.sdpInvitationId;
      return sdpInvitationId === undefined
        ? []
        : [{ clerkInvitationId: invitation.id, sdpInvitationId }];
    });
  }

  /**
   * Revokes a pending Clerk invitation, naming no requesting user (ADR 0012).
   *
   * @param params.organizationId - The Clerk organization id.
   * @param params.invitationId - The Clerk invitation id.
   * @returns The revoked Clerk invitation.
   */
  async revokeOrganizationInvitation(params: {
    organizationId: string;
    invitationId: string;
  }): Promise<ClerkOrganizationInvitation> {
    return this.request<ClerkOrganizationInvitation>(
      `/organizations/${params.organizationId}/invitations/${params.invitationId}/revoke`,
      { method: "POST" }
    );
  }

  /**
   * Reads the organization as Clerk holds it now, so a sync never applies an
   * older webhook payload over a newer state.
   *
   * @param organizationId - The Clerk organization id.
   * @returns The organization, or null once Clerk no longer has it.
   */
  async getOrganization(organizationId: string): Promise<ClerkOrganization | null> {
    try {
      const organization = await this.request<unknown>(`/organizations/${organizationId}`);
      return clerkOrganizationSchema.parse(organization);
    } catch (error) {
      if (error instanceof AppError && error.details?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Renames the Clerk organization to the name SDP holds.
   *
   * @param params.organizationId - The Clerk organization id.
   * @param params.name - The organization's name.
   */
  async updateOrganizationName(params: { organizationId: string; name: string }): Promise<void> {
    await this.request<unknown>(`/organizations/${params.organizationId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: params.name }),
    });
  }

  /**
   * Creates a Clerk organization naming no creator (ADR 0012): Clerk would
   * otherwise make that person its `org:admin`. The SDP organization id rides
   * in private metadata so an operator can trace an orphan back.
   *
   * @param params.name - The organization's name.
   * @param params.sdpOrganizationId - The SDP organization it stands for.
   * @returns The Clerk organization id.
   */
  async createOrganization(params: { name: string; sdpOrganizationId: string }): Promise<string> {
    const created = await this.request<unknown>("/organizations", {
      method: "POST",
      body: JSON.stringify({
        name: params.name,
        private_metadata: { sdpOrganizationId: params.sdpOrganizationId },
      }),
    });
    return z.object({ id: z.string() }).parse(created).id;
  }

  /**
   * Whether the user already holds a membership of the Clerk organization.
   *
   * @param params.organizationId - The Clerk organization id.
   * @param params.userId - The Clerk user id.
   * @returns True when Clerk lists a membership for the user; false when it lists none or the organization no longer exists.
   */
  async hasOrganizationMembership(params: {
    organizationId: string;
    userId: string;
  }): Promise<boolean> {
    try {
      const page = await this.request<unknown>(
        `/organizations/${params.organizationId}/memberships?user_id=${encodeURIComponent(params.userId)}`
      );
      return z.object({ total_count: z.number() }).parse(page).total_count > 0;
    } catch (error) {
      if (error instanceof AppError && error.details?.status === 404) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Adds the user to the Clerk organization as `org:member`, the only Clerk
   * role anyone holds (ADR 0012).
   *
   * @param params.organizationId - The Clerk organization id.
   * @param params.userId - The Clerk user id.
   */
  async createOrganizationMembership(params: {
    organizationId: string;
    userId: string;
  }): Promise<void> {
    await this.request<unknown>(`/organizations/${params.organizationId}/memberships`, {
      method: "POST",
      body: JSON.stringify({ user_id: params.userId, role: "org:member" }),
    });
  }

  async deleteOrganizationMembership(params: {
    organizationId: string;
    userId: string;
  }): Promise<void> {
    await this.request<unknown>(
      `/organizations/${params.organizationId}/memberships/${params.userId}`,
      { method: "DELETE" }
    );
  }

  async updateOrganizationPrivateMetadata(
    organizationId: string,
    privateMetadata: Record<string, unknown>
  ): Promise<ClerkOrganization> {
    // Clerk no longer accepts `private_metadata` on PATCH /organizations/{id};
    // PUT on the metadata endpoint replaces the field, matching the old behaviour.
    return this.request<ClerkOrganization>(`/organizations/${organizationId}/metadata`, {
      method: "PUT",
      body: JSON.stringify({
        private_metadata: privateMetadata,
      }),
    });
  }
}
