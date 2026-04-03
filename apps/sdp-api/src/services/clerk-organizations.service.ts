import { AppError } from "@/lib/errors";
import type { Env } from "@/types/env";

export interface ClerkOrganizationInvitation {
  id: string;
  email_address: string;
  role: string;
  status: string;
  created_at?: number;
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

  constructor(private env: Env) {
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
      throw new AppError("INTERNAL_ERROR", "Clerk request failed", {
        status: res.status,
        body,
      });
    }

    if (res.status === 204) {
      return {} as T;
    }

    return (await res.json()) as T;
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

  async getOrganization(organizationId: string): Promise<ClerkOrganization> {
    return this.request<ClerkOrganization>(`/organizations/${organizationId}`);
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
