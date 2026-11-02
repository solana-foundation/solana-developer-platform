import { z } from "zod";

export const connectionParamsSchema = z.object({ connectionId: z.string().trim().min(1) }).strict();
export const credentialParamsSchema = z.object({ credentialId: z.string().trim().min(1) }).strict();
