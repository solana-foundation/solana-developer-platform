import { AppError } from "@/lib/errors";
import type { Env } from "@/types/env";

export interface ClerkEmailAddress {
  id: string;
  email_address: string;
}

export interface ClerkUser {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  primary_email_address_id?: string | null;
  email_addresses?: ClerkEmailAddress[];
}

export class ClerkUsersService {
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

  async getUser(userId: string): Promise<ClerkUser> {
    return this.request<ClerkUser>(`/users/${userId}`);
  }
}
