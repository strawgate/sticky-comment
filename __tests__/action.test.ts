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
    delete: vi.fn().mockImplementation(async () => {
      current = null;
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
        delete: vi.fn(),
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

  describe("timestamp ordering", () => {
    it("does not overwrite a section with a newer timestamp", async () => {
      const state: State = {
        header: "",
        style: "summary",
        sections: {
          build: { title: "Build", status: "success", body: "done", updatedAt: 2000 },
        },
        order: ["build"],
      };
      const api = mockApi(makeExisting(state));
      // Our update has an OLDER timestamp
      const inputs = defaultInputs({
        section: "build",
        title: "Build",
        status: "pending",
        body: "starting...",
        timestamp: 1000,
      });

      await run(inputs, api);

      const parsed = parseState((api.update as Mock).mock.calls[0][1] as string, "test");
      // The newer "success" should be preserved, not overwritten by stale "pending"
      expect(parsed?.sections.build.status).toBe("success");
      expect(parsed?.sections.build.body).toBe("done");
      expect(parsed?.sections.build.updatedAt).toBe(2000);
    });

    it("overwrites a section with an older timestamp", async () => {
      const state: State = {
        header: "",
        style: "summary",
        sections: {
          build: { title: "Build", status: "pending", body: "running", updatedAt: 1000 },
        },
        order: ["build"],
      };
      const api = mockApi(makeExisting(state));
      const inputs = defaultInputs({
        section: "build",
        title: "Build",
        status: "success",
        body: "done!",
        timestamp: 2000,
      });

      await run(inputs, api);

      const parsed = parseState((api.update as Mock).mock.calls[0][1] as string, "test");
      expect(parsed?.sections.build.status).toBe("success");
      expect(parsed?.sections.build.body).toBe("done!");
      expect(parsed?.sections.build.updatedAt).toBe(2000);
    });

    it("stops retrying when a newer writer overwrote our section", async () => {
      // Existing state has no build section
      const initialState: State = {
        header: "",
        style: "summary",
        sections: {},
        order: [],
      };

      // After our write, a NEWER writer overwrote with their own build status
      const newerState: State = {
        header: "",
        style: "summary",
        sections: {
          build: { title: "Build", status: "success", body: "from newer", updatedAt: 3000 },
        },
        order: ["build"],
      };
      const newerBody = `<!-- sticky:test -->\n<!-- sticky:test:state:${encodeState(newerState)} -->`;

      let writeCount = 0;
      const api: CommentApi = {
        findByMarker: vi.fn().mockImplementation(async () => {
          if (writeCount === 0) return makeExisting(initialState);
          // Verification: newer writer overwrote us
          return { id: 42, body: newerBody, url: "https://github.com/test/42" };
        }),
        create: vi.fn(),
        update: vi.fn().mockImplementation(async (id: number, body: string) => {
          writeCount++;
          return { id, body, url: `https://github.com/test/${id}` };
        }),
        delete: vi.fn(),
      };

      const inputs = defaultInputs({
        section: "build",
        title: "Build",
        status: "pending",
        body: "starting",
        timestamp: 1000, // older than the newer writer's 3000
      });

      await run(inputs, api);

      // Should NOT retry — the newer write is correct, accept it
      expect(api.update).toHaveBeenCalledTimes(1);
    });
  });

  describe("delete mode", () => {
    it("deletes the entire comment when no section specified", async () => {
      const state: State = {
        header: "CI",
        style: "summary",
        sections: { lint: { title: "Lint", status: "success", body: "ok" } },
        order: ["lint"],
      };
      const api = mockApi(makeExisting(state));
      const inputs = defaultInputs({ mode: "delete" });

      const result = await run(inputs, api);

      expect(api.delete).toHaveBeenCalledWith(42);
      expect(result).toBeNull();
    });

    it("returns null when deleting a non-existent comment", async () => {
      const api = mockApi();
      const inputs = defaultInputs({ mode: "delete" });

      const result = await run(inputs, api);

      expect(api.delete).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it("removes a single section and re-renders", async () => {
      const state: State = {
        header: "",
        style: "summary",
        sections: {
          lint: { title: "Lint", status: "success", body: "ok" },
          test: { title: "Tests", status: "failure", body: "3 failed" },
        },
        order: ["lint", "test"],
      };
      const api = mockApi(makeExisting(state));
      const inputs = defaultInputs({ mode: "delete", section: "lint" });

      const result = await run(inputs, api);

      expect(api.delete).not.toHaveBeenCalled();
      expect(api.update).toHaveBeenCalledTimes(1);
      const parsed = parseState(result?.body ?? "", "test");
      expect(parsed?.sections.lint).toBeUndefined();
      expect(parsed?.sections.test?.body).toBe("3 failed");
      expect(parsed?.order).toEqual(["test"]);
    });

    it("deletes entire comment when removing the last section", async () => {
      const state: State = {
        header: "",
        style: "summary",
        sections: { lint: { title: "Lint", status: "success", body: "ok" } },
        order: ["lint"],
      };
      const api = mockApi(makeExisting(state));
      const inputs = defaultInputs({ mode: "delete", section: "lint" });

      const result = await run(inputs, api);

      expect(api.delete).toHaveBeenCalledWith(42);
      expect(result).toBeNull();
    });

    it("returns existing comment when deleting a non-existent section", async () => {
      const state: State = {
        header: "",
        style: "summary",
        sections: { lint: { title: "Lint", status: "success", body: "ok" } },
        order: ["lint"],
      };
      const existing = makeExisting(state);
      const api = mockApi(existing);
      const inputs = defaultInputs({ mode: "delete", section: "nonexistent" });

      const result = await run(inputs, api);

      // Section doesn't exist, so state is unchanged — still updates to clean the render
      expect(api.delete).not.toHaveBeenCalled();
      expect(api.update).toHaveBeenCalledTimes(1);
      const parsed = parseState(result?.body ?? "", "test");
      expect(parsed?.sections.lint).toBeTruthy();
    });
  });

  describe("init + section combo", () => {
    it("init mode with section creates comment with config and section", async () => {
      const api = mockApi();
      const inputs = defaultInputs({
        mode: "init",
        header: "CI",
        style: "full",
        section: "lint",
        title: "Lint",
        status: "success",
        body: "ok",
      });

      const result = await run(inputs, api);

      expect(result?.body).toContain("## CI");
      expect(result?.body).toContain("ok");
      // full style: headings not details
      expect(result?.body).toContain("### ");
      expect(result?.body).not.toContain("<details");
    });
  });

  describe("corrupted state", () => {
    it("falls back to blank state when existing comment has corrupted state", async () => {
      const api = mockApi({
        id: 42,
        body: "<!-- sticky:test -->\n<!-- sticky:test:state:TOTALLY_BROKEN!!! -->\ngarbage",
        url: "https://github.com/test/42",
      });
      const inputs = defaultInputs({
        section: "lint",
        title: "Lint",
        status: "success",
        body: "ok",
      });

      const result = await run(inputs, api);

      // Should still work — creates fresh state
      expect(result?.body).toContain("ok");
      const parsed = parseState(result?.body ?? "", "test");
      expect(parsed?.sections.lint?.status).toBe("success");
    });

    it("falls back to blank state when existing comment has no state marker", async () => {
      const api = mockApi({
        id: 42,
        body: "<!-- sticky:test -->\njust some text with no state",
        url: "https://github.com/test/42",
      });
      const inputs = defaultInputs({
        section: "build",
        title: "Build",
        status: "pending",
        body: "building",
      });

      const result = await run(inputs, api);

      const parsed = parseState(result?.body ?? "", "test");
      expect(parsed?.sections.build?.body).toBe("building");
      expect(parsed?.order).toEqual(["build"]);
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

    it("preserves previous body when new body is empty string", async () => {
      const state: State = {
        header: "",
        style: "summary",
        sections: { lint: { title: "Lint", status: "success", body: "keep this" } },
        order: ["lint"],
      };
      const api = mockApi(makeExisting(state));
      const inputs = defaultInputs({ section: "lint", status: "failure", body: "" });

      await run(inputs, api);

      const parsed = parseState((api.update as Mock).mock.calls[0][1] as string, "test");
      expect(parsed?.sections.lint.body).toBe("keep this");
      expect(parsed?.sections.lint.status).toBe("failure");
    });

    it("allows overwriting body with whitespace-only content", async () => {
      const state: State = {
        header: "",
        style: "summary",
        sections: { lint: { title: "Lint", status: "success", body: "old" } },
        order: ["lint"],
      };
      const api = mockApi(makeExisting(state));
      const inputs = defaultInputs({ section: "lint", body: "   " });

      await run(inputs, api);

      const parsed = parseState((api.update as Mock).mock.calls[0][1] as string, "test");
      expect(parsed?.sections.lint.body).toBe("   ");
    });

    it("handles section with same timestamp as existing (overwrites)", async () => {
      const state: State = {
        header: "",
        style: "summary",
        sections: { x: { title: "X", status: "pending", body: "old", updatedAt: 5000 } },
        order: ["x"],
      };
      const api = mockApi(makeExisting(state));
      const inputs = defaultInputs({
        section: "x",
        status: "success",
        body: "new",
        timestamp: 5000,
      });

      await run(inputs, api);

      const parsed = parseState((api.update as Mock).mock.calls[0][1] as string, "test");
      expect(parsed?.sections.x.status).toBe("success");
      expect(parsed?.sections.x.body).toBe("new");
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
