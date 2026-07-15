/**
 * Ports Module
 *
 * Exports all port interfaces for the hexagonal architecture.
 * Ports define the boundaries between domain and infrastructure.
 */

// Fee payment port - gasless transaction sponsorship
export type {
  ExtendedFeePaymentPort,
  FeePaymentErrorCode,
  FeePaymentPort,
} from "@sdp/payments/fee-payment/port";
export { FeePaymentError } from "@sdp/payments/fee-payment/port";
