import { describe, expect, it } from "vitest";
import { render } from "../src/render";
import { parseState, type State } from "../src/state";

function makeState(overrides: Partial<State> = {}): State {
  return { header: "", style: "summary", sections: {}, order: [], ...overrides };
}

describe("render", () => {
  it("includes marker and state data", () => {
    const output = render("test", makeState());
    expect(output).toContain("<!-- sticky:test -->");
    expect(output).toContain("<!-- sticky:test:state:");
  });

  it("shows header when set", () => {
    const output = render("test", makeState({ header: "CI" }));
    expect(output).toContain("## CI");
  });

  it("shows waiting message when no sections", () => {
    const output = render("test", makeState({ header: "CI" }));
    expect(output).toContain("*Waiting for results");
  });

  describe("summary style", () => {
    const state = makeState({
      style: "summary",
      sections: {
        lint: { title: "Lint", status: "success", body: "All good" },
        test: { title: "Tests", status: "failure", body: "3 failed" },
      },
      order: ["lint", "test"],
    });

    it("does not render status table", () => {
      const output = render("id", state);
      expect(output).not.toContain("| Check | Status |");
    });

    it("renders collapsed details blocks", () => {
      const output = render("id", state);
      expect(output).toContain("<details>");
      expect(output).toContain("<summary>");
      expect(output).toContain("All good");
      expect(output).toContain("3 failed");
    });

    it("auto-expands failure sections", () => {
      const output = render("id", state);
      // success → collapsed
      expect(output).toMatch(/<details>\n<summary>.*Lint/);
      // failure → open
      expect(output).toMatch(/<details open>\n<summary>.*Tests/);
    });
  });

  describe("full style", () => {
    const state = makeState({
      style: "full",
      sections: {
        lint: { title: "Lint", status: "success", body: "ok" },
      },
      order: ["lint"],
    });

    it("renders headings instead of details", () => {
      const output = render("id", state);
      expect(output).toContain("### ");
      expect(output).not.toContain("<details");
    });

    it("does not render status table", () => {
      const output = render("id", state);
      expect(output).not.toContain("| Check |");
    });
  });

  describe("status-only style", () => {
    const state = makeState({
      style: "status-only",
      sections: {
        lint: { title: "Lint", status: "success", body: "ok" },
      },
      order: ["lint"],
    });

    it("renders status table", () => {
      const output = render("id", state);
      expect(output).toContain("| Check | Status |");
    });

    it("does not render section bodies", () => {
      const output = render("id", state);
      expect(output).not.toContain("<details");
      expect(output).not.toContain("### ");
      expect(output).not.toContain("ok");
    });
  });

  it("shows dash for empty status in status-only table", () => {
    const state = makeState({
      style: "status-only",
      sections: { x: { title: "X", status: "", body: "" } },
      order: ["x"],
    });
    const output = render("id", state);
    expect(output).toContain("| X | \u2014 |");
  });

  it.each([
    ["success", "\u2705", "Pass"],
    ["failure", "\u274C", "Fail"],
    ["pending", "\u23F3", "Running"],
    ["warning", "\u26A0\uFE0F", "Warning"],
    ["skipped", "\u23ED\uFE0F", "Skipped"],
    ["cancelled", "\uD83D\uDEAB", "Cancelled"],
    ["info", "\u2139\uFE0F", "Info"],
  ])("renders %s status with correct emoji and label", (status, emoji, label) => {
    const state = makeState({
      sections: { x: { title: "X", status, body: "content" } },
      order: ["x"],
    });
    const output = render("id", state);
    expect(output).toContain(emoji);
    expect(output).toContain(label);
  });

  it("renders unknown status as plain title (no emoji)", () => {
    const state = makeState({
      sections: { x: { title: "X", status: "custom-thing", body: "content" } },
      order: ["x"],
    });
    const output = render("id", state);
    expect(output).toContain("<summary>X</summary>");
    expect(output).not.toContain("custom-thing");
  });

  it("renders info status", () => {
    const state = makeState({
      sections: { x: { title: "Notes", status: "info", body: "Some info" } },
      order: ["x"],
    });
    const output = render("id", state);
    expect(output).toContain("\u2139\uFE0F");
    expect(output).toContain("Info");
    expect(output).toContain("Some info");
  });

  it("shows 'No output.' for empty body", () => {
    const state = makeState({
      sections: { x: { title: "X", status: "success", body: "" } },
      order: ["x"],
    });
    const output = render("id", state);
    expect(output).toContain("*No output.*");
  });

  it("skips sections not in order array", () => {
    const state = makeState({
      sections: {
        a: { title: "A", status: "success", body: "content-a" },
        b: { title: "B", status: "success", body: "content-b" },
      },
      order: ["a"],
    });
    const output = render("id", state);
    expect(output).toContain("content-a");
    expect(output).not.toContain("content-b");
  });

  it("roundtrips state through render + parse", () => {
    const state = makeState({
      header: "Test",
      style: "summary",
      sections: {
        lint: { title: "Lint", status: "success", body: "Multi\nline\nbody" },
      },
      order: ["lint"],
    });
    const output = render("test", state);
    const parsed = parseState(output, "test");
    expect(parsed).toEqual(state);
  });

  it("roundtrips markdown-heavy body through render + parse", () => {
    const body = [
      "| File | Coverage |",
      "|------|----------|",
      "| `src/main.ts` | 95% |",
      "",
      "```typescript",
      'const x = "hello";',
      "```",
      "",
      "- item 1",
      "- item **2**",
      "- <details><summary>nested</summary>inner</details>",
    ].join("\n");
    const state = makeState({
      style: "summary",
      sections: { cov: { title: "Coverage", status: "info", body } },
      order: ["cov"],
    });
    const output = render("test", state);
    const parsed = parseState(output, "test");
    expect(parsed).toEqual(state);
  });

  it("does not render ## when header is empty", () => {
    const state = makeState({
      header: "",
      sections: { x: { title: "X", status: "success", body: "ok" } },
      order: ["x"],
    });
    const output = render("id", state);
    expect(output).not.toContain("## ");
  });

  it("handles special characters in comment-id", () => {
    const output = render("my-ci.status", makeState());
    expect(output).toContain("<!-- sticky:my-ci.status -->");
    expect(output).toContain("<!-- sticky:my-ci.status:state:");
  });

  it("renders many sections in order", () => {
    const sections: Record<string, { title: string; status: string; body: string }> = {};
    const order: string[] = [];
    for (let i = 0; i < 20; i++) {
      const key = `s${i}`;
      sections[key] = { title: `Section ${i}`, status: "success", body: `body-${i}` };
      order.push(key);
    }
    const state = makeState({ sections, order });
    const output = render("test", state);
    // All 20 should appear in order
    const positions = order.map((k) => output.indexOf(`body-${k.slice(1)}`));
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });
});
