import { KeychainPrivyAdapter } from "@sdp/custody/keychain/keychain-privy.adapter";
import { assert, type Mock } from "vitest";

/**
 * Returns the Privy adapter that the spied `getTransactionSigner` last ran on, so a test can read
 * the config the API built for it.
 *
 * @param getTransactionSigner - Spy on `KeychainPrivyAdapter.prototype.getTransactionSigner`.
 * @returns The adapter bound as `this` on the spy's most recent call.
 */
export function lastPrivyAdapter(
  getTransactionSigner: Mock<KeychainPrivyAdapter["getTransactionSigner"]>
): KeychainPrivyAdapter {
  const adapter = getTransactionSigner.mock.contexts.at(-1);
  assert.instanceOf(adapter, KeychainPrivyAdapter);
  return adapter;
}
