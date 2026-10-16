import { z } from "zod";
import { solanaAddressSchema } from "../payments/schemas";

export const transactionRequestBodySchema = z.object({ account: solanaAddressSchema("account") });
