import assert from "node:assert/strict";
import { it } from "node:test";
import { PrivyAuthService } from "./privy";

it("sends the app id and UTF-8 basic credentials", () => {
  assert.deepEqual(
    new PrivyAuthService().injectCredentials({ appId: "app_7k2", appSecret: "sécret" }),
    {
      Authorization: "Basic YXBwXzdrMjpzw6ljcmV0",
      "privy-app-id": "app_7k2",
    }
  );
});
