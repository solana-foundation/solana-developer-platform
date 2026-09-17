import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("renders the hero, all three steps, and the earn button", () => {
    const html = renderToString(<App />);
    expect(html).toContain("Give your customers yield with one code snippet");
    expect(html).toContain('id="custody"');
    expect(html).toContain('id="configure"');
    expect(html).toContain('id="earn"');
    expect(html).toContain("Earn 8.43%");
  });
});
