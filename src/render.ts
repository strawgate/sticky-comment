import { encodeState, type State } from "./state";

export const STATUS_MAP: Record<string, { emoji: string; label: string }> = {
  success: { emoji: "\u2705", label: "Pass" },
  failure: { emoji: "\u274C", label: "Fail" },
  pending: { emoji: "\u23F3", label: "Running" },
  warning: { emoji: "\u26A0\uFE0F", label: "Warning" },
  skipped: { emoji: "\u23ED\uFE0F", label: "Skipped" },
  cancelled: { emoji: "\uD83D\uDEAB", label: "Cancelled" },
};

function statusStr(key: string): string {
  const s = STATUS_MAP[key];
  return s ? `${s.emoji} ${s.label}` : "";
}

export function render(id: string, state: State): string {
  const out: string[] = [];

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

  // Status table (summary & status-only styles)
  if (state.style !== "full") {
    out.push("| Check | Status |");
    out.push("|-------|--------|");
    for (const s of sections) {
      out.push(`| ${s.title} | ${statusStr(s.status) || "\u2014"} |`);
    }
    out.push("");
  }

  // Section bodies (summary & full styles)
  if (state.style !== "status-only") {
    for (const s of sections) {
      const heading = statusStr(s.status) ? `${statusStr(s.status)} ${s.title}` : s.title;
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

  return `${out.join("\n").trimEnd()}\n`;
}
