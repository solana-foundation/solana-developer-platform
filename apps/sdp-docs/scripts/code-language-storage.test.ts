import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { readCodeLanguage, storeCodeLanguage } from "@/lib/code-language-storage";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

function storage(cause?: Error) {
  const values = new Map<string, string>();
  return {
    getItem(key: string): string | null {
      if (cause !== undefined) throw cause;
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      if (cause !== undefined) throw cause;
      values.set(key, value);
    },
  };
}

function fullStorage() {
  return {
    ...storage(),
    setItem(): void {
      throw new DOMException("Storage full", "QuotaExceededError");
    },
  };
}

function browser(
  sessionStorage: ReturnType<typeof storage>,
  localStorage: ReturnType<typeof storage>
) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { sessionStorage, localStorage },
  });
}

afterEach(() => {
  if (originalWindow === undefined) Reflect.deleteProperty(globalThis, "window");
  else Object.defineProperty(globalThis, "window", originalWindow);
});

describe("optional code-language storage", () => {
  it("reads session preferences before persisted preferences", () => {
    const session = storage();
    const local = storage();
    local.setItem("code", "python");
    browser(session, local);
    assert.equal(readCodeLanguage("code", false), undefined);
    assert.equal(readCodeLanguage("code", true), "python");
    session.setItem("code", "typescript");
    assert.equal(readCodeLanguage("code", true), "typescript");
  });

  it("writes persisted preferences only when requested", () => {
    const session = storage();
    const local = storage();
    browser(session, local);
    storeCodeLanguage("code", "python", false);
    assert.equal(session.getItem("code"), "python");
    assert.equal(local.getItem("code"), null);
    storeCodeLanguage("code", "typescript", true);
    assert.equal(session.getItem("code"), "typescript");
    assert.equal(local.getItem("code"), "typescript");
  });

  it("allows controls to continue when privacy settings deny storage", () => {
    const blocked = storage(new DOMException("Storage denied", "SecurityError"));
    browser(blocked, blocked);
    assert.equal(readCodeLanguage("code", true), undefined);
    assert.doesNotThrow(() => storeCodeLanguage("code", "python", true));
  });

  it("allows controls to continue when session storage is full", () => {
    browser(fullStorage(), storage());
    assert.doesNotThrow(() => storeCodeLanguage("code", "python", false));
    assert.equal(readCodeLanguage("code", false), undefined);
  });

  it("keeps the session preference when persistent storage is full", () => {
    const session = storage();
    browser(session, fullStorage());
    assert.doesNotThrow(() => storeCodeLanguage("code", "python", true));
    assert.equal(session.getItem("code"), "python");
    assert.equal(readCodeLanguage("code", true), "python");
  });

  it("surfaces a quota error from a storage read", () => {
    const cause = new DOMException("Unexpected read failure", "QuotaExceededError");
    const broken = storage(cause);
    browser(broken, broken);
    assert.throws(() => readCodeLanguage("code", true), cause);
  });

  it("surfaces unexpected storage failures", () => {
    const cause = new TypeError("Broken storage implementation");
    const broken = storage(cause);
    browser(broken, broken);
    assert.throws(() => readCodeLanguage("code", true), cause);
    assert.throws(() => storeCodeLanguage("code", "python", true), cause);
  });
});
