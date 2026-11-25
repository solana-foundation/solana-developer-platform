import { operationIntentSchema } from "@sdp/types/operations";

/** Strategy selection and a funding source prepare one deposit intent. */
export const prepareEarnDepositSchema = operationIntentSchema.options[0].omit({ kind: true });

/** The position supplies the strategy and owner for every exit. */
export const prepareEarnWithdrawalSchema = operationIntentSchema.options[1].omit({ kind: true });
