import type { CoinbaseRampEvent } from "@sdp/types";
import { z } from "zod";

export const coinbaseRampEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("committed"), orderId: z.string().min(1) }),
  z.object({ kind: z.literal("errored"), orderId: z.string().min(1), reason: z.string().min(1) }),
]) satisfies z.ZodType<CoinbaseRampEvent>;
