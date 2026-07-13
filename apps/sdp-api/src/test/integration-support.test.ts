import { describe, expect, it } from "vitest";
import { apiTestSupport } from "./integration-support";

describe("apiTestSupport", () => {
  it("exposes the integration harness surface", () => {
    expect(typeof apiTestSupport.app.request).toBe("function");
    expect(typeof apiTestSupport.getDb).toBe("function");
    expect(typeof apiTestSupport.seedTestDatabase).toBe("function");
    expect(typeof apiTestSupport.clearTestDatabase).toBe("function");
    expect(typeof apiTestSupport.createSigningService).toBe("function");
    expect(typeof apiTestSupport.createToken2022Service).toBe("function");
    expect(apiTestSupport.TEST_PROJECT.id).toBeTruthy();
  });
});
