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

/**
 * Stateful mock: tracks the last written body so that verification
 * reads after a write return the updated content.
 */
function mockApi(initial: { id: number; body: string; url: string } | null = null): CommentApi {
  let current = initial ? { ...initial } : null;

  return {
    findByMarker: vi.fn().mockImplementation(async () => (current ? { ...current } : null)),
    create: vi.fn().mockImplementation(async (body: string) => {
      current = { id: 1, body, url: "https://github.com/test/1" };
      return { ...current };
    }),
    update: vi.fn().mockImplementation(async (id: number, body: string) => {
      current = { id, body, url: `https://github.com/test/${id}` };
      return { ...current };
    }),
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

  describe("conflict retry", () => {
    it("retries when another writer overwrites our update", async () => {
      // Start with lint section
      const initialState: State = {
        header: "",
        style: "summary",
        sections: { lint: { title: "Lint", status: "success", body: "ok" } },
        order: ["lint"],
      };

      // Simulate conflict: after our write, another job overwrites with
      // a different state (their build section, but our test section is gone).
      const conflictState: State = {
        header: "",
        style: "summary",
        sections: {
          lint: { title: "Lint", status: "success", body: "ok" },
          build: { title: "Build", status: "success", body: "built" },
        },
        order: ["lint", "build"],
      };
      const conflictBody = `<!-- sticky:test -->\n<!-- sticky:test:state:${encodeState(conflictState)} -->`;

      let writeCount = 0;
      const api: CommentApi = {
        findByMarker: vi.fn().mockImplementation(async () => {
          if (writeCount === 0) {
            // First read: initial state
            return makeExisting(initialState);
          }
          if (writeCount === 1) {
            // Verification read after first write: someone else overwrote us
            return { id: 42, body: conflictBody, url: "https://github.com/test/42" };
          }
          // Second read (retry): still the conflict state (our section missing)
          // After second write: return what we wrote
          return {
            id: 42,
            body: (api.update as Mock).mock.lastCall?.[1] ?? conflictBody,
            url: "https://github.com/test/42",
          };
        }),
        create: vi.fn(),
        update: vi.fn().mockImplementation(async (id: number, body: string) => {
          writeCount++;
          return { id, body, url: `https://github.com/test/${id}` };
        }),
      };

      const inputs = defaultInputs({
        section: "test",
        title: "Tests",
        status: "failure",
        body: "3 failed",
      });

      const result = await run(inputs, api);

      // Should have retried: 2 update calls
      expect(api.update).toHaveBeenCalledTimes(2);

      // Final result should contain BOTH the conflict's build section AND our test section
      const finalState = parseState(result?.body ?? "", "test");
      expect(finalState?.sections.build).toBeTruthy();
      expect(finalState?.sections.test?.body).toBe("3 failed");
      expect(finalState?.order).toContain("build");
      expect(finalState?.order).toContain("test");
    }, 15000);

    it("succeeds on first try when no conflict", async () => {
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
        status: "success",
        body: "all pass",
      });

      await run(inputs, api);

      // findByMarker: 1 initial read + 1 verification = 2 calls, no retry
      expect(api.findByMarker).toHaveBeenCalledTimes(2);
      expect(api.update).toHaveBeenCalledTimes(1);
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
