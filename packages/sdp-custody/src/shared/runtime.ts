export interface CustodyProvisioningRuntime {
  fetch: typeof globalThis.fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  randomUUID: () => string;
  getRandomValues: (values: Uint8Array) => Uint8Array;
  sha256: (data: Uint8Array) => Promise<ArrayBuffer>;
}
