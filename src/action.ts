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
}

export interface Inputs {
  mode: "init" | "update";
  commentId: string;
  style: Style;
  header: string;
  section: string;
  title: string;
  status: string;
  body: string;
}

const MAX_COMMENT_LENGTH = 65536;

export async function run(inputs: Inputs, api: CommentApi): Promise<Comment | null> {
  const marker = `<!-- sticky:${inputs.commentId} -->`;

  // Find existing comment
  const existing = await api.findByMarker(marker);

  // Build / restore state
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

  // Upsert section
  if (inputs.section) {
    if (!state.order.includes(inputs.section)) {
      state.order.push(inputs.section);
    }
    const prev = state.sections[inputs.section];
    state.sections[inputs.section] = {
      title: inputs.title || prev?.title || inputs.section,
      status: inputs.status || prev?.status || "",
      body: inputs.body !== "" ? inputs.body : prev?.body || "",
    };
  } else if (inputs.mode === "update") {
    // update mode with no section — nothing to change
    return existing ?? null;
  }

  // Render
  let rendered = render(inputs.commentId, state);

  if (rendered.length > MAX_COMMENT_LENGTH) {
    rendered = `${rendered.slice(0, MAX_COMMENT_LENGTH - 60)}\n\n---\n*Comment truncated.*\n`;
  }

  // Create or update
  if (existing) {
    return api.update(existing.id, rendered);
  }
  return api.create(rendered);
}
