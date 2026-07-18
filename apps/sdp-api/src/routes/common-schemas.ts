import { z } from "zod";

export const queryBooleanSchema = z.preprocess((val) => {
  if (val === "true" || val === "1") return true;
  if (val === "false" || val === "0") return false;
  return val;
}, z.boolean());
