import { z } from "zod";
import { solanaAddressSchema } from "@/routes/payments/schemas";

export const transactionRequestBodySchema = z.object({ account: solanaAddressSchema("account") });
