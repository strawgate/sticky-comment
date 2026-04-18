export type Style = "summary" | "full" | "status-only";

export interface SectionData {
  title: string;
  status: string;
  body: string;
  /** Unix timestamp (ms) of the most recent update. Used to resolve conflicts. */
  updatedAt?: number;
}

export interface State {
  header: string;
  style: Style;
  sections: Record<string, SectionData>;
  order: string[];
}

export function encodeState(state: State): string {
  return Buffer.from(JSON.stringify(state)).toString("base64");
}

export function decodeState(b64: string): State | null {
  try {
    return JSON.parse(Buffer.from(b64, "base64").toString()) as State;
  } catch {
    return null;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseState(body: string, id: string): State | null {
  const re = new RegExp(`<!-- sticky:${escapeRe(id)}:state:([A-Za-z0-9+/=]+) -->`);
  const m = body.match(re);
  return m ? decodeState(m[1]) : null;
}
