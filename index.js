// Sticky PR Comment — single-file GitHub Action (no dependencies).
//
// Maintains one comment per PR identified by an HTML-comment marker.
// Multiple jobs/workflows can each own a named section; the action
// merges them and re-renders the whole comment on every update.

const https = require("https");
const fs = require("fs");

// ── Status rendering ────────────────────────────────────────────────
const STATUS = {
  success:   { emoji: "\u2705", label: "Pass" },
  failure:   { emoji: "\u274C", label: "Fail" },
  pending:   { emoji: "\u23F3", label: "Running" },
  warning:   { emoji: "\u26A0\uFE0F",  label: "Warning" },
  skipped:   { emoji: "\u23ED\uFE0F",  label: "Skipped" },
  cancelled: { emoji: "\uD83D\uDEAB", label: "Cancelled" },
};

// ── Input / output helpers ──────────────────────────────────────────
function input(name) {
  return process.env[`INPUT_${name.toUpperCase().replace(/-/g, "_")}`] || "";
}

function setOutput(name, value) {
  const f = process.env.GITHUB_OUTPUT;
  if (f) fs.appendFileSync(f, `${name}=${value}\n`);
}

function die(msg) {
  console.log(`::error::${msg}`);
  process.exit(1);
}

// ── GitHub REST helpers ─────────────────────────────────────────────
function api(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api.github.com",
      path,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "sticky-comment-action",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    };
    if (body) opts.headers["Content-Type"] = "application/json";
    const req = https.request(opts, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        if (res.statusCode >= 400) {
          reject(new Error(`${method} ${path} -> ${res.statusCode}: ${buf}`));
        } else {
          resolve(buf ? JSON.parse(buf) : null);
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function findComment(owner, repo, issue, marker, token) {
  for (let page = 1; ; page++) {
    const url = `/repos/${owner}/${repo}/issues/${issue}/comments?per_page=100&page=${page}`;
    const comments = await api("GET", url, null, token);
    if (!comments.length) return null;
    const hit = comments.find((c) => c.body?.includes(marker));
    if (hit) return hit;
  }
}

// ── State codec ─────────────────────────────────────────────────────
// State is stored as base64-encoded JSON inside an HTML comment so it
// survives any markdown rendering and is invisible to readers.

function encodeState(state) {
  return Buffer.from(JSON.stringify(state)).toString("base64");
}

function decodeState(b64) {
  try {
    return JSON.parse(Buffer.from(b64, "base64").toString());
  } catch {
    return null;
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseState(body, id) {
  const re = new RegExp(`<!-- sticky:${escapeRe(id)}:state:([A-Za-z0-9+/=]+) -->`);
  const m = body.match(re);
  return m ? decodeState(m[1]) : null;
}

// ── Renderer ────────────────────────────────────────────────────────

function statusStr(key) {
  const s = STATUS[key];
  return s ? `${s.emoji} ${s.label}` : "";
}

function render(id, state) {
  const out = [];

  // Hidden markers (identifier + serialised state)
  out.push(`<!-- sticky:${id} -->`);
  out.push(`<!-- sticky:${id}:state:${encodeState(state)} -->`);
  out.push("");

  if (state.header) {
    out.push(`## ${state.header}`);
    out.push("");
  }

  const sections = state.order
    .filter((k) => state.sections[k])
    .map((k) => ({ key: k, ...state.sections[k] }));

  if (!sections.length) {
    out.push("*Waiting for results\u2026*");
    return out.join("\n");
  }

  // ── Status table (summary & status-only styles) ──
  if (state.style !== "full") {
    out.push("| Check | Status |");
    out.push("|-------|--------|");
    for (const s of sections) {
      out.push(`| ${s.title} | ${statusStr(s.status) || "\u2014"} |`);
    }
    out.push("");
  }

  // ── Section bodies (summary & full styles) ──
  if (state.style !== "status-only") {
    for (const s of sections) {
      const heading = statusStr(s.status)
        ? `${statusStr(s.status)} ${s.title}`
        : s.title;
      const hasBody = s.body?.trim();

      if (state.style === "full") {
        out.push(`### ${heading}`);
        out.push("");
        out.push(hasBody ? s.body : "*No output.*");
      } else {
        // summary — collapsed by default, auto-open on failure
        const open = s.status === "failure" ? " open" : "";
        out.push(`<details${open}>`);
        out.push(`<summary>${heading}</summary>`);
        out.push("");
        out.push(hasBody ? s.body : "*No output.*");
        out.push("");
        out.push("</details>");
      }
      out.push("");
    }
  }

  return out.join("\n").trimEnd() + "\n";
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const token = input("token") || process.env.GITHUB_TOKEN;
  if (!token) die("No token. Pass token input or set GITHUB_TOKEN.");

  const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
  const mode = input("mode") || "update";
  const id = input("comment-id") || "sticky-comment";
  const style = input("style") || "summary";
  const header = input("header");
  const section = input("section");
  const title = input("title") || section;
  const status = input("status");

  let body = input("body");
  const bodyPath = input("body-path");
  if (bodyPath && !body) {
    body = fs.readFileSync(bodyPath, "utf8");
  }

  // Resolve PR / issue number
  let issue = input("issue-number");
  if (!issue && process.env.GITHUB_EVENT_PATH) {
    const ev = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    issue =
      ev.pull_request?.number || ev.issue?.number || ev.number || "";
  }
  if (!issue) die("Cannot determine PR/issue number. Set issue-number input.");

  const marker = `<!-- sticky:${id} -->`;

  // Find existing comment
  const existing = await findComment(owner, repo, issue, marker, token);

  // Build / restore state
  const blank = { header: header || "", style, sections: {}, order: [] };
  let state;

  if (existing) {
    state = parseState(existing.body, id) || blank;
    if (mode === "init") {
      if (header) state.header = header;
      state.style = style;
    }
  } else {
    state = blank;
  }

  // Upsert section
  if (section) {
    if (!state.order.includes(section)) state.order.push(section);
    const prev = state.sections[section] || {};
    state.sections[section] = {
      title: title || prev.title || section,
      status: status || prev.status || "",
      body: body !== "" ? body : prev.body || "",
    };
  } else if (mode === "update") {
    // update mode with no section — nothing to do
    if (existing) {
      console.log("No section provided in update mode; nothing to do.");
      setOutput("comment-id", existing.id);
      setOutput("comment-url", existing.html_url);
      return;
    }
    // no comment yet and no section — skip silently
    console.log("No comment exists and no section provided; skipping.");
    return;
  }

  // Render
  let rendered = render(id, state);

  // GitHub comment body limit: 65 536 characters
  const MAX = 65536;
  if (rendered.length > MAX) {
    console.log(`::warning::Comment body is ${rendered.length} chars; truncating to ${MAX}.`);
    rendered =
      rendered.slice(0, MAX - 60) + "\n\n---\n*Comment truncated.*\n";
  }

  // Create or update
  let result;
  if (existing) {
    result = await api(
      "PATCH",
      `/repos/${owner}/${repo}/issues/comments/${existing.id}`,
      { body: rendered },
      token
    );
    console.log(`Updated: ${result.html_url}`);
  } else {
    result = await api(
      "POST",
      `/repos/${owner}/${repo}/issues/${issue}/comments`,
      { body: rendered },
      token
    );
    console.log(`Created: ${result.html_url}`);
  }

  setOutput("comment-id", result.id);
  setOutput("comment-url", result.html_url);
}

main().catch((e) => die(e.message));
