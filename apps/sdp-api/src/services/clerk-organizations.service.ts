import { AppError } from "@/lib/errors";
import type { Env } from "@/types/env";
import { describeClerkFailure } from "./clerk-error";

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
  slug?: string;
  private_metadata?: Record<string, unknown> | null;
}

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
    const res = await fetch(`${this.apiBase}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new AppError("INTERNAL_ERROR", describeClerkFailure(res.status, body), {
        status: res.status,
        body,
      });
    }

    if (res.status === 204) {
      return {} as T;
    }

    return (await res.json()) as T;
  }

  async getOrganization(organizationId: string): Promise<ClerkOrganization> {
    return this.request<ClerkOrganization>(`/organizations/${organizationId}`);
  }

  async createOrganizationInvitation(params: {
    organizationId: string;
    inviterUserId: string;
    emailAddress: string;
    role: string;
    redirectUrl?: string;
    publicMetadata?: Record<string, unknown>;
  }): Promise<ClerkOrganizationInvitation> {
    const payload = {
      inviter_user_id: params.inviterUserId,
      email_address: params.emailAddress,
      role: params.role,
      ...(params.redirectUrl ? { redirect_url: params.redirectUrl } : {}),
      ...(params.publicMetadata ? { public_metadata: params.publicMetadata } : {}),
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

  async revokeOrganizationInvitation(params: {
    organizationId: string;
    invitationId: string;
    requestingUserId: string;
  }): Promise<ClerkOrganizationInvitation> {
    return this.request<ClerkOrganizationInvitation>(
      `/organizations/${params.organizationId}/invitations/${params.invitationId}/revoke`,
      {
        method: "POST",
        body: JSON.stringify({ requesting_user_id: params.requestingUserId }),
      }
    );
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
    return this.request<ClerkOrganization>(`/organizations/${organizationId}`, {
      method: "PATCH",
      body: JSON.stringify({
        private_metadata: privateMetadata,
      }),
    });
  }
}
