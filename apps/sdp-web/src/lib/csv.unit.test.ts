import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";

describe("toCsv", () => {
  it("quotes cells with separators and doubles embedded quotes", () => {
    expect(
      toCsv(
        ["a", "b"],
        [
          ["x,y", 'say "hi"'],
          [null, "plain"],
        ]
      )
    ).toBe('a,b\r\n"x,y","say ""hi"""\r\n,plain\r\n');
  });

  it("neutralises formula cells but keeps signed numbers numeric", () => {
    expect(toCsv(["v"], [["=HYPERLINK(1)"], ["-15.5"], ["@sum"]])).toBe(
      "v\r\n'=HYPERLINK(1)\r\n-15.5\r\n'@sum\r\n"
    );
  });
});
