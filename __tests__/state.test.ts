import { describe, expect, it } from "vitest";
import { decodeState, encodeState, parseState, type State } from "../src/state";

const sample: State = {
  header: "CI Status",
  style: "summary",
  sections: {
    lint: { title: "Lint", status: "success", body: "All good" },
  },
  order: ["lint"],
};

describe("encodeState / decodeState", () => {
  it("round-trips a state object", () => {
    const encoded = encodeState(sample);
    expect(decodeState(encoded)).toEqual(sample);
  });

  it("handles empty state", () => {
    const empty: State = { header: "", style: "summary", sections: {}, order: [] };
    expect(decodeState(encodeState(empty))).toEqual(empty);
  });

  it("handles multi-line body content", () => {
    const state: State = {
      ...sample,
      sections: { x: { title: "X", status: "failure", body: "line1\nline2\nline3" } },
    };
    expect(decodeState(encodeState(state))).toEqual(state);
  });

  it("returns null for corrupted base64", () => {
    expect(decodeState("not-valid!!!")).toBeNull();
  });

  it("returns null for valid base64 but invalid JSON", () => {
    const encoded = Buffer.from("not json").toString("base64");
    expect(decodeState(encoded)).toBeNull();
  });
});

describe("parseState", () => {
  it("extracts state from a comment body", () => {
    const body = [
      "<!-- sticky:test -->",
      `<!-- sticky:test:state:${encodeState(sample)} -->`,
      "",
      "## CI Status",
      "rendered content...",
    ].join("\n");
    expect(parseState(body, "test")).toEqual(sample);
  });

  it("returns null when no state marker exists", () => {
    expect(parseState("just a plain comment", "test")).toBeNull();
  });

  it("returns null when marker id doesn't match", () => {
    const body = `<!-- sticky:other:state:${encodeState(sample)} -->`;
    expect(parseState(body, "test")).toBeNull();
  });

  it("returns null for corrupted state data", () => {
    expect(parseState("<!-- sticky:test:state:BROKEN!!! -->", "test")).toBeNull();
  });

  it("escapes regex special characters in id", () => {
    const id = "my.comment(1)";
    const body = `<!-- sticky:${id}:state:${encodeState(sample)} -->`;
    expect(parseState(body, id)).toEqual(sample);
  });
});
