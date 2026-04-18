import * as fs from "node:fs";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { type Comment, type CommentApi, type Inputs, run } from "./action";
import type { Style } from "./state";

function buildApi(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  issueNumber: number,
): CommentApi {
  return {
    async findByMarker(marker: string): Promise<Comment | null> {
      for (let page = 1; ; page++) {
        const { data } = await octokit.rest.issues.listComments({
          owner,
          repo,
          issue_number: issueNumber,
          per_page: 100,
          page,
        });
        if (!data.length) return null;
        const hit = data.find((c) => c.body?.includes(marker));
        if (hit) {
          return { id: hit.id, body: hit.body || "", url: hit.html_url };
        }
      }
    },

    async create(body: string): Promise<Comment> {
      const { data } = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body,
      });
      return { id: data.id, body: data.body || "", url: data.html_url };
    },

    async update(id: number, body: string): Promise<Comment> {
      const { data } = await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: id,
        body,
      });
      return { id: data.id, body: data.body || "", url: data.html_url };
    },
  };
}

async function main(): Promise<void> {
  const token = core.getInput("token", { required: true });
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;

  // Resolve issue number
  let issueNumber = Number.parseInt(core.getInput("issue-number"), 10);
  if (!issueNumber || Number.isNaN(issueNumber)) {
    const payload = github.context.payload;
    issueNumber = payload.pull_request?.number || payload.issue?.number || payload.number || 0;
  }
  if (!issueNumber) {
    core.setFailed("Cannot determine PR/issue number. Set issue-number input.");
    return;
  }

  const api = buildApi(octokit, owner, repo, issueNumber);

  // Read body from file if body-path is set
  let body = core.getInput("body");
  const bodyPath = core.getInput("body-path");
  if (bodyPath && !body) {
    body = fs.readFileSync(bodyPath, "utf8");
  }

  const section = core.getInput("section");
  const inputs: Inputs = {
    mode: (core.getInput("mode") || "update") as "init" | "update",
    commentId: core.getInput("comment-id") || "sticky-comment",
    style: (core.getInput("style") || "summary") as Style,
    header: core.getInput("header"),
    section,
    title: core.getInput("title") || section,
    status: core.getInput("status"),
    body,
    timestamp: Date.now(),
  };

  const result = await run(inputs, api);

  if (result) {
    core.setOutput("comment-id", result.id);
    core.setOutput("comment-url", result.url);
    core.info(`Comment: ${result.url}`);
  } else {
    core.info("No changes needed.");
  }
}

main().catch((error) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
