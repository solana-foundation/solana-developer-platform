"use server";

import { revalidatePath } from "next/cache";
import { createOrgSdpApiClient } from "@/lib/sdp-api";

export interface AllowlistEntry {
  id: string;
  type: "email" | "domain";
  value: string;
  tier: string;
  status: "active" | "disabled";
  createdAt: string;
}

export async function listAllowlistEntries(): Promise<AllowlistEntry[]> {
  const client = await createOrgSdpApiClient();
  const response = await client.fetch<{ entries: AllowlistEntry[] }>("/admin/allowlist");
  return response.entries;
}

export async function addAllowlistEntry(formData: FormData) {
  const value = String(formData.get("value") ?? "").trim();
  const type = (String(formData.get("type") ?? "email").trim() || "email") as "email" | "domain";

  if (!value) {
    throw new Error("Allowlist value is required");
  }

  const client = await createOrgSdpApiClient();
  await client.fetch("/admin/allowlist", {
    method: "POST",
    body: JSON.stringify({ type, value }),
  });

  revalidatePath("/allowlist");
}

export async function removeAllowlistEntry(formData: FormData) {
  const id = String(formData.get("id") ?? "").trim();
  if (!id) {
    throw new Error("Allowlist entry id is required");
  }

  const client = await createOrgSdpApiClient();
  await client.fetch(`/admin/allowlist/${id}`, {
    method: "DELETE",
  });

  revalidatePath("/allowlist");
}
