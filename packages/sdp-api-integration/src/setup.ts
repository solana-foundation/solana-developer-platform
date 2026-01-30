const globalWithSecureContext = globalThis as { isSecureContext?: boolean };

if (!globalWithSecureContext.isSecureContext) {
  try {
    Object.defineProperty(globalThis, "isSecureContext", {
      value: true,
      configurable: true,
    });
  } catch {
    globalWithSecureContext.isSecureContext = true;
  }
}
