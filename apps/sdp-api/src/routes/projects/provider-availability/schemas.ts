import { z } from "zod";

export const projectProviderAvailabilityParamsSchema = z.object({
  projectId: z.string().min(1),
});
