import { z } from "zod";
import type { FireblocksCsr } from "@/app/(session)/dashboard/[projectId]/wallets/setup/fireblocks-csr-actions";
import { parseErrorMessage } from "@/lib/api-error";
import { dashboardRequest } from "@/lib/dashboard-fetch";

const fireblocksCsrSchema = z.object({
  id: z.string(),
  csrPem: z.string(),
  expiresAt: z.string(),
}) satisfies z.ZodType<FireblocksCsr>;

const pendingFireblocksCsrSchema = z.object({ csr: fireblocksCsrSchema.nullable() });

export type PendingFireblocksCsr = z.infer<typeof pendingFireblocksCsrSchema>;

export async function fetchPendingFireblocksCsr(): Promise<PendingFireblocksCsr> {
  const response = await dashboardRequest("/api/dashboard/fireblocks/csr", {
    method: "GET",
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(parseErrorMessage(await response.text()));
  }
  return pendingFireblocksCsrSchema.parse(await response.json());
}
