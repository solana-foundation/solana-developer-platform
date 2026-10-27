import { ORGANIZATION_ROLES } from "@sdp/types/roles";
import { z } from "zod";

export const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(ORGANIZATION_ROLES),
});

export const updateMemberRoleSchema = z.object({
  role: z.enum(ORGANIZATION_ROLES),
});
