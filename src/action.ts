import { render } from "./render";
import { parseState, type State, type Style } from "./state";

export interface Comment {
  id: number;
  body: string;
  url: string;
}

/** Thin interface over GitHub's comment API — makes testing trivial. */
export interface CommentApi {
  findByMarker(marker: string): Promise<Comment | null>;
  create(body: string): Promise<Comment>;
  update(id: number, body: string): Promise<Comment>;
  delete(id: number): Promise<void>;
}

export interface Inputs {
  mode: "init" | "update" | "delete";
  commentId: string;
  style: Style;
  header: string;
  section: string;
  title: string;
  status: string;
  body: string;
  /** Unix timestamp (ms) captured once at action start; reused across retries. */
  timestamp?: number;
}

const MAX_COMMENT_LENGTH = 65536;
const MAX_RETRIES = 3;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 5000;

function randomDelay(): Promise<void> {
  const ms = RETRY_MIN_MS + Math.random() * (RETRY_MAX_MS - RETRY_MIN_MS);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build state from an existing comment (or blank) and apply inputs. */
function buildState(existing: Comment | null, inputs: Inputs): State | null {
  const blank: State = {
    header: inputs.header || "",
    style: inputs.style,
    sections: {},
    order: [],
  };

  let state: State;
  if (existing) {
    state = parseState(existing.body, inputs.commentId) || blank;
    if (inputs.mode === "init") {
      if (inputs.header) state.header = inputs.header;
      state.style = inputs.style;
    }
  } else {
    state = blank;
  }

  // Upsert section — only overwrite if our timestamp is newer
  if (inputs.section) {
    if (!state.order.includes(inputs.section)) {
      state.order.push(inputs.section);
    }
    const prev = state.sections[inputs.section];
    const now = inputs.timestamp ?? Date.now();
    if (!prev?.updatedAt || now >= prev.updatedAt) {
      state.sections[inputs.section] = {
        title: inputs.title || prev?.title || inputs.section,
        status: inputs.status || prev?.status || "",
        body: inputs.body !== "" ? inputs.body : prev?.body || "",
        updatedAt: now,
      };
    }
  } else if (inputs.mode === "update") {
    return null; // nothing to change
  }

  return state;
}

function renderBody(id: string, state: State): string {
  let rendered = render(id, state);
  if (rendered.length > MAX_COMMENT_LENGTH) {
    rendered = `${rendered.slice(0, MAX_COMMENT_LENGTH - 60)}\n\n---\n*Comment truncated.*\n`;
  }
  return rendered;
}

/** Check whether our section survived in the comment after writing. */
function verifyWrite(comment: Comment, inputs: Inputs): boolean {
  if (!inputs.section) return true;
  const state = parseState(comment.body, inputs.commentId);
  if (!state?.sections[inputs.section]) return false;
  const s = state.sections[inputs.section];
  const ts = inputs.timestamp ?? 0;
  // Our timestamp must match — if someone newer overwrote us, that's correct and we stop retrying
  if (ts && s.updatedAt && s.updatedAt > ts) return true; // newer update is fine
  if (ts && s.updatedAt && s.updatedAt < ts) return false; // our write was lost
  // Check our values are present
  if (inputs.status && s.status !== inputs.status) return false;
  if (inputs.body && s.body !== inputs.body) return false;
  return true;
}

export async function run(inputs: Inputs, api: CommentApi): Promise<Comment | null> {
  const marker = `<!-- sticky:${inputs.commentId} -->`;

  // Delete mode
  if (inputs.mode === "delete") {
    const existing = await api.findByMarker(marker);
    if (!existing) return null;

    if (!inputs.section) {
      // Delete the entire comment
      await api.delete(existing.id);
      return null;
    }

    // Delete a single section
    const state = parseState(existing.body, inputs.commentId);
    if (!state) return existing;
    delete state.sections[inputs.section];
    state.order = state.order.filter((k) => k !== inputs.section);

    if (Object.keys(state.sections).length === 0) {
      // No sections left — delete the whole comment
      await api.delete(existing.id);
      return null;
    }

    const rendered = renderBody(inputs.commentId, state);
    return api.update(existing.id, rendered);
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Read current state
    const existing = await api.findByMarker(marker);

    // Build new state
    const state = buildState(existing, inputs);
    if (state === null) return existing ?? null;

    // Write
    const rendered = renderBody(inputs.commentId, state);
    let result: Comment;
    if (existing) {
      result = await api.update(existing.id, rendered);
    } else {
      result = await api.create(rendered);
    }

    // Verify our write stuck (skip verification if truncated or on last attempt)
    const wasTruncated = rendered.includes("*Comment truncated.*");
    if (attempt < MAX_RETRIES && inputs.section && !wasTruncated) {
      const verified = await api.findByMarker(marker);
      if (verified && verifyWrite(verified, inputs)) {
        return result;
      }
      // Lost the race — sleep random 1-5s and retry
      await randomDelay();
      continue;
    }

    return result;
  }

  return null; // unreachable, but satisfies the type checker
}
