import type { z } from "zod";

export const jsonContent = (schema: z.ZodTypeAny) => ({
  "application/json": { schema },
});

export const errorResponses = (schema: z.ZodTypeAny, codes: number[]) =>
  Object.fromEntries(
    codes.map((code) => [
      code,
      {
        description: "Error",
        content: jsonContent(schema),
      },
    ])
  );
