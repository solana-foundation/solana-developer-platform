import { z } from "zod";

const nullableCustodyWalletIdSchema = z.string().min(1).nullable();

export function parseNullableCustodyWalletId(value: unknown): string | null {
  return nullableCustodyWalletIdSchema.parse(value);
}
