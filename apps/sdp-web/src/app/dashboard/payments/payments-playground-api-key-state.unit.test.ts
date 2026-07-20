import { describe, expect, it, vi } from "vitest";
import { syncPlaygroundApiKeysForActiveTab } from "./payments-playground-api-key-state";

describe("Payments playground API key state", () => {
  it("does not clear the selected key when an Overview response omits playground data", () => {
    const setPlaygroundApiKeys = vi.fn();

    syncPlaygroundApiKeysForActiveTab(false, [], setPlaygroundApiKeys);

    expect(setPlaygroundApiKeys).not.toHaveBeenCalled();
  });

  it("publishes the complete key list once the playground is active", () => {
    const setPlaygroundApiKeys = vi.fn();
    const apiKeys = [{ id: "key-1" }, { id: "key-2" }];

    syncPlaygroundApiKeysForActiveTab(true, apiKeys, setPlaygroundApiKeys);

    expect(setPlaygroundApiKeys).toHaveBeenCalledOnce();
    expect(setPlaygroundApiKeys).toHaveBeenCalledWith(apiKeys);
  });
});
