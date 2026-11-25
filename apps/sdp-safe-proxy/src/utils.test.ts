import assert from "node:assert/strict";
import { it } from "node:test";
import { z } from "zod";
import { positiveInteger, readEnv } from "@/utils";

it("names every missing, empty or invalid setting and none of the values", () => {
  process.env.SETTING_SET = "value-q83";
  process.env.SETTING_EMPTY = "";
  process.env.SETTING_ZERO = "0";

  assert.throws(
    () =>
      readEnv({
        SETTING_SET: z.string().min(1),
        SETTING_UNSET: z.string().min(1),
        SETTING_EMPTY: z.string().min(1),
        SETTING_ZERO: positiveInteger,
      }),
    { message: "invalid settings: SETTING_UNSET, SETTING_EMPTY, SETTING_ZERO" }
  );
});
