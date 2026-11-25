import { z } from "zod";

export const positiveInteger = z.coerce.number().int().positive();

// Reads the named settings from the environment. A failure names the settings, never a value.
export function readEnv<Shape extends z.ZodRawShape>(shape: Shape): z.infer<z.ZodObject<Shape>> {
  const parsed = z.object(shape).safeParse(process.env);
  if (parsed.success) return parsed.data;
  const names = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
  throw new Error(`invalid settings: ${names.join(", ")}`);
}
