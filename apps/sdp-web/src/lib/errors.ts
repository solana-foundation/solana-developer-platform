export function paymentCounterpartiesMissing(counterpartyIds: readonly string[]): Error {
  return new Error(
    `Payments workspace could not resolve counterparties: ${counterpartyIds.join(", ")}`
  );
}

export function paymentTransferCounterpartyMissing(transferId: string): Error {
  return new Error(`Payment transfer ${transferId} has no resolvable counterparty`);
}

export function paymentTransferTypeMissing(): Error {
  return new Error("Payment transfer type is missing");
}
