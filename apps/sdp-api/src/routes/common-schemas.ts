import { z } from "zod";

export const queryBooleanSchema = z.stringbool({ truthy: ["true", "1"], falsy: ["false", "0"] });
