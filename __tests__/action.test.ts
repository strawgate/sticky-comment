import { describe, expect, it, type Mock, vi } from "vitest";
import { type CommentApi, type Inputs, run } from "../src/action";
import { encodeState, parseState, type State } from "../src/state";

function defaultInputs(overrides: Partial<Inputs> = {}): Inputs {
  return {
    mode: "update",
    commentId: "test",
    style: "summary",
    header: "",
    section: "",
    title: "",
    status: "",
    body: "",
    ...overrides,
  };
}

function mockApi(existing: { id: number; body: string; url: string } | null = null): CommentApi {
  return {
    findByMarker: vi.fn().mockResolvedValue(existing),
    create: vi.fn().mockImplementation(async (body: string) => ({
      id: 1,
      body,
      url: "https://github.com/test/1",
    })),
    update: vi.fn().mockImplementation(async (id: number, body: string) => ({
      id,
      body,
      url: `https://github.com/test/${id}`,
    })),
  };
}

function makeExisting(state: State): { id: number; body: string; url: string } {
  return {
    id: 42,
    body: `<!-- sticky:test -->\n<!-- sticky:test:state:${encodeState(state)} -->\nold`,
    url: "https://github.com/test/42",
  };
}

describe("run", () => {
  describe("creating comments", () => {
    it("creates a new comment with a section", async () => {
      const api = mockApi();
      const inputs = defaultInputs({
        section: "lint",
        title: "Lint",
        status: "success",
        body: "All good",
      });

      const result = await run(inputs, api);

      expect(api.findByMarker).toHaveBeenCalledWith("<!-- sticky:test -->");
      expect(api.create).toHaveBeenCalledTimes(1);
      expect(api.update).not.toHaveBeenCalled();
      expect(result).toBeTruthy();
      expect(result?.body).toContain("All good");
    });

    it("init mode creates empty comment with header", async () => {
      const api = mockApi();
      const inputs = defaultInputs({ mode: "init", header: "CI Status" });

      const result = await run(inputs, api);

      expect(api.create).toHaveBeenCalledTimes(1);
      expect(result?.body).toContain("## CI Status");
      expect(result?.body).toContain("Waiting for results");
    });
  });

  describe("updating comments", () => {
    it("updates an existing section", async () => {
      const state: State = {
        header: "CI",
        style: "summary",
        sections: { lint: { title: "Lint", status: "pending", body: "Running..." } },
        order: ["lint"],
      };
      const api = mockApi(makeExisting(state));
      const inputs = defaultInputs({
        section: "lint",
        title: "Lint",
        status: "success",
        body: "Done!",
      });

      await run(inputs, api);

      expect(api.update).toHaveBeenCalledTimes(1);
      expect(api.create).not.toHaveBeenCalled();
      const updatedBody = (api.update as Mock).mock.calls[0][1] as string;
      expect(updatedBody).toContain("Done!");
    });

    it("adds a new section to existing comment", async () => {
      const state: State = {
        header: "",
        style: "summary",
        sections: { lint: { title: "Lint", status: "success", body: "ok" } },
        order: ["lint"],
      };
      const api = mockApi(makeExisting(state));
      const inputs = defaultInputs({
        section: "test",
        title: "Tests",
        status: "failure",
        body: "3 failed",
      });

      await run(inputs, api);

      const updatedBody = (api.update as Mock).mock.calls[0][1] as string;
      expect(updatedBody).toContain("Lint");
      expect(updatedBody).toContain("Tests");
      expect(updatedBody).toContain("3 failed");

      // Verify round-trip: the embedded state should have both sections
      const parsed = parseState(updatedBody, "test");
      expect(parsed?.order).toEqual(["lint", "test"]);
    });

    it("preserves previous section when updating another", async () => {
      const state: State = {
        header: "",
        style: "summary",
        sections: { lint: { title: "Lint", status: "success", body: "lint ok" } },
        order: ["lint"],
      };
      const api = mockApi(makeExisting(state));
      const inputs = defaultInputs({
        section: "build",
        title: "Build",
        status: "pending",
        body: "building...",
      });

      await run(inputs, api);

      const updatedBody = (api.update as Mock).mock.calls[0][1] as string;
      expect(updatedBody).toContain("lint ok");
      expect(updatedBody).toContain("building...");
    });
  });

  describe("no-op cases", () => {
    it("update mode without section returns existing comment", async () => {
      const existing = { id: 42, body: "<!-- sticky:test -->", url: "https://test/42" };
      const api = mockApi(existing);

      const result = await run(defaultInputs(), api);

      expect(result).toEqual(existing);
      expect(api.create).not.toHaveBeenCalled();
      expect(api.update).not.toHaveBeenCalled();
    });

    it("update mode without section and no comment returns null", async () => {
      const api = mockApi();

      const result = await run(defaultInputs(), api);

      expect(result).toBeNull();
      expect(api.create).not.toHaveBeenCalled();
    });
  });

  describe("init mode config", () => {
    it("init mode overrides header and style on existing comment", async () => {
      const state: State = {
        header: "Old",
        style: "full",
        sections: { lint: { title: "Lint", status: "success", body: "ok" } },
        order: ["lint"],
      };
      const api = mockApi(makeExisting(state));
      const inputs = defaultInputs({
        mode: "init",
        header: "New Header",
        style: "status-only",
      });

      await run(inputs, api);

      const updatedBody = (api.update as Mock).mock.calls[0][1] as string;
      expect(updatedBody).toContain("## New Header");
      // status-only: no details blocks
      expect(updatedBody).not.toContain("<details");
    });
  });

  describe("edge cases", () => {
    it("falls back to section id when title is empty", async () => {
      const api = mockApi();
      const inputs = defaultInputs({
        section: "my-check",
        title: "",
        status: "success",
        body: "ok",
      });

      const result = await run(inputs, api);

      expect(result?.body).toContain("my-check");
    });

    it("preserves previous status when new status is empty", async () => {
      const state: State = {
        header: "",
        style: "summary",
        sections: { lint: { title: "Lint", status: "success", body: "old" } },
        order: ["lint"],
      };
      const api = mockApi(makeExisting(state));
      const inputs = defaultInputs({ section: "lint", body: "new body" });

      await run(inputs, api);

      const parsed = parseState((api.update as Mock).mock.calls[0][1] as string, "test");
      expect(parsed?.sections.lint.status).toBe("success");
      expect(parsed?.sections.lint.body).toBe("new body");
    });

    it("truncates comments exceeding 65536 characters", async () => {
      const api = mockApi();
      const inputs = defaultInputs({
        section: "big",
        title: "Big",
        status: "success",
        body: "x".repeat(70000),
      });

      const result = await run(inputs, api);

      expect(result?.body.length).toBeLessThanOrEqual(65536);
      expect(result?.body).toContain("*Comment truncated.*");
    });
  });
});
