import { AppError } from "@/lib/errors";
import type { Env } from "@/types/env";
import type { AllowlistEntry } from "./allowlist.service";

interface ClerkAllowlistIdentifier {
  id: string;
  identifier: string;
  identifierType?: string;
  createdAt?: number;
  updatedAt?: number;
}

interface ClerkAllowlistResponse {
  data: ClerkAllowlistIdentifier[];
  total_count?: number;
}

export class ClerkAllowlistService {
  private apiBase: string;
  private secretKey: string;

  constructor(private env: Env) {
    if (!env.CLERK_SECRET_KEY) {
      throw new AppError("INTERNAL_ERROR", "CLERK_SECRET_KEY is required for Clerk allowlist");
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
      throw new AppError("INTERNAL_ERROR", "Clerk allowlist request failed", {
        status: res.status,
        body,
      });
    }

    if (res.status === 204) {
      return {} as T;
    }

    return (await res.json()) as T;
  }

  private async listIdentifiers(): Promise<ClerkAllowlistIdentifier[]> {
    const limit = 100;
    let offset = 0;
    const all: ClerkAllowlistIdentifier[] = [];

    while (true) {
      const response = await this.request<ClerkAllowlistResponse>(
        `/allowlist-identifiers?limit=${limit}&offset=${offset}`
      );
      const batch = response.data || [];
      all.push(...batch);

      if (batch.length < limit) {
        break;
      }

      if (response.total_count !== undefined && all.length >= response.total_count) {
        break;
      }

      offset += limit;
    }

    return all;
  }

  private toAllowlistEntry(identifier: ClerkAllowlistIdentifier): AllowlistEntry {
    const value = identifier.identifier.toLowerCase();
    const type = value.includes("@") ? "email" : "domain";

    return {
      id: identifier.id,
      type,
      value,
      tier: "standard",
      notes: null,
      status: "active",
      createdAt: identifier.createdAt
        ? new Date(identifier.createdAt).toISOString()
        : new Date().toISOString(),
    };
  }

  async listEntries(
    options: {
      type?: "email" | "domain";
      status?: "active" | "disabled";
    } = {}
  ): Promise<AllowlistEntry[]> {
    if (options.status && options.status !== "active") {
      return [];
    }

    const identifiers = await this.listIdentifiers();
    const entries = identifiers.map((identifier) => this.toAllowlistEntry(identifier));

    if (options.type) {
      return entries.filter((entry) => entry.type === options.type);
    }

    return entries;
  }

  async addEntry(entry: {
    id?: string;
    type: "email" | "domain";
    value: string;
    tier?: string;
    notes?: string;
  }): Promise<AllowlistEntry> {
    const identifier = entry.value.toLowerCase().trim();

    const created = await this.request<ClerkAllowlistIdentifier>("/allowlist-identifiers", {
      method: "POST",
      body: JSON.stringify({ identifier, notify: false }),
    });

    return this.toAllowlistEntry({
      ...created,
      identifier,
      id: created.id,
    });
  }

  async removeEntry(id: string): Promise<void> {
    await this.request(`/allowlist-identifiers/${id}`, {
      method: "DELETE",
    });
  }

  async getEntry(id: string): Promise<AllowlistEntry | null> {
    const identifiers = await this.listIdentifiers();
    const match = identifiers.find((identifier) => identifier.id === id);
    return match ? this.toAllowlistEntry(match) : null;
  }

  async isEmailAllowed(email: string): Promise<{ allowed: boolean; tier: string }> {
    const normalizedEmail = email.toLowerCase().trim();
    const domain = normalizedEmail.split("@")[1];
    const identifiers = await this.listIdentifiers();

    const match = identifiers.find((identifier) => {
      const value = identifier.identifier.toLowerCase();
      return value === normalizedEmail || value === domain;
    });

    return { allowed: Boolean(match), tier: "standard" };
  }
}
