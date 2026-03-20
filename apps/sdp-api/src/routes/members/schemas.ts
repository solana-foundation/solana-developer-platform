import { z } from "zod";

export const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "member"]),
});

export const acceptSchema = z.object({
  token: z.string().min(1),
  name: z.string().min(1).max(100).optional(),
});
