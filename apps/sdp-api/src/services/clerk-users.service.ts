import type { OrganizationJSON } from "@clerk/backend";
import { AppError } from "@/lib/errors";
import { logVendorCallFailure } from "@/runtime/vendor-calls";
import type { Env } from "@/types/env";
import { describeClerkFailure } from "./clerk-error";

export interface ClerkEmailAddress {
  id: string;
  email_address: string;
  verification?: {
    status?: string | null;
  } | null;
}

export interface ClerkUser {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  primary_email_address_id?: string | null;
  email_addresses?: ClerkEmailAddress[];
}

export function verifiedPrimaryEmailFromClerkUser(user: ClerkUser): string | null {
  const emails = user.email_addresses || [];
  const primary = emails.find((item) => item.id === user.primary_email_address_id);
  if (primary?.verification?.status !== "verified") {
    return null;
  }
  return primary.email_address.toLowerCase();
}

export interface ClerkOrganizationMembership {
  role: string;
  organization: OrganizationJSON;
}

interface ClerkOrganizationMembershipPage {
  data: ClerkOrganizationMembership[];
  total_count: number;
}

export class ClerkUsersService {
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
      throw new AppError("INTERNAL_ERROR", describeClerkFailure(res.status, body), {
        status: res.status,
        body,
      });
    }

    if (res.status === 204) {
      return {} as T;
    }

    return (await res.json().catch((error: unknown) => {
      logVendorCallFailure("clerk", operation, error, startedAt);
      throw error;
    })) as T;
  }

  async getUser(userId: string): Promise<ClerkUser> {
    return this.request<ClerkUser>(`/users/${userId}`);
  }

  async getOrganizationMemberships(userId: string): Promise<ClerkOrganizationMembership[]> {
    const memberships: ClerkOrganizationMembership[] = [];
    const limit = 500;

    while (true) {
      const page = await this.request<ClerkOrganizationMembershipPage>(
        `/users/${userId}/organization_memberships?limit=${limit}&offset=${memberships.length}`
      );
      memberships.push(...page.data);

      if (page.data.length === 0 || memberships.length >= page.total_count) {
        return memberships;
      }
    }
  }
}
