import { z } from "zod";

export const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(MEMBER_ROLES),
});

export const acceptSchema = z.object({
  token: z.string().min(1),
  name: z.string().min(1).max(100).optional(),
});

import { MEMBER_ROLES } from "@sdp/types";
