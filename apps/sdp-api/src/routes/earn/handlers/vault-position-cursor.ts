import { z } from "zod";
import { decodeKeysetCursor, encodeKeysetCursor } from "@/lib/keyset-cursor";

const vaultPositionCursorSchema = z.object({
  createdAt: z.string().datetime({ precision: 3 }),
  id: z
    .string()
    .min(1)
    .max(128)
    .refine((id) => id === id.toLowerCase()),
});

export interface VaultPositionCursor {
  createdAt: string;
  id: string;
}

export function encodeVaultPositionCursor(createdAt: string, id: string): string {
  return encodeKeysetCursor(createdAt, id);
}

export function decodeVaultPositionCursor(cursor: string): VaultPositionCursor | null {
  const decoded = decodeKeysetCursor(cursor);
  if (!decoded) return null;
  const parsed = vaultPositionCursorSchema.safeParse({ createdAt: decoded.value, id: decoded.id });
  return parsed.success ? parsed.data : null;
}
