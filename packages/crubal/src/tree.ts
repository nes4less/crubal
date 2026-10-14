// tree.ts: the text form's lines (spec chapter 2.1), read into a tree of nodes without knowing what any
// key means. Comments are stripped, tabs in indentation are refused, and a line belongs inside the nearest
// earlier line that is indented less.

export class CrubalError extends Error {
  readonly line: number | undefined;
  constructor(message: string, line?: number) {
    super(line ? `line ${line}: ${message}` : message);
    this.name = "CrubalError";
    this.line = line;
  }
}

export type Node = {
  /** "pair" is `key: value` or `key:`; "item" is a `- ` list item; "line" is anything else. */
  kind: "pair" | "item" | "line";
  /** The key of a pair; null otherwise. */
  key: string | null;
  /** The text after the separator (pair), after `- ` (item, when it isn't a pair), or the whole line. */
  value: string;
  /** The line's whole text, comment and indentation removed. */
  text: string;
  line: number;
  /** The column the line's text starts at. */
  indent: number;
  children: Node[];
};

/** Remove a `//` comment that starts the line or follows white space, outside quotes. */
export function stripComment(line: string): string {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted && ch === "\\") {
      i++;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === "/" && line[i + 1] === "/" && (i === 0 || /\s/.test(line[i - 1] ?? ""))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

/**
 * Split a line into a pair at the separator (spec 2.1): the first `: ` (colon then space), or a colon at
 * the end of the line. A colon inside quotes never separates.
 */
export function splitPair(text: string): { key: string; value: string } | null {
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted && ch === "\\") {
      i++;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    if (quoted || ch !== ":") continue;
    if (i === text.length - 1) return i > 0 ? { key: text.slice(0, i), value: "" } : null;
    if (text[i + 1] === " ") {
      const key = text.slice(0, i);
      if (!key || /\s/.test(key)) return null;
      return { key, value: text.slice(i + 2).trim() };
    }
  }
  return null;
}

function lineNode(body: string, line: number, indent: number): Node {
  const pair = splitPair(body);
  if (pair) return { kind: "pair", key: pair.key, value: pair.value, text: body, line, indent, children: [] };
  return { kind: "line", key: null, value: body, text: body, line, indent, children: [] };
}

/** The lines inside a node, as written: each with its indentation relative to the first, comments removed. */
export function innerText(node: Node): string {
  const lines: { indent: number; text: string; line: number }[] = [];
  const seen = new Set<number>();
  const walk = (n: Node) => {
    for (const c of n.children) {
      if (!seen.has(c.line)) {
        seen.add(c.line);
        lines.push({ indent: c.indent, text: c.text, line: c.line });
      }
      walk(c);
    }
  };
  walk(node);
  lines.sort((a, b) => a.line - b.line);
  const base = lines[0]?.indent ?? 0;
  return lines.map((l) => " ".repeat(Math.max(0, l.indent - base)) + l.text).join("\n");
}

/** Read text into a tree of nodes. */
export function readTree(source: string): Node[] {
  const root: Node = { kind: "line", key: null, value: "", text: "", line: 0, indent: -1, children: [] };
  const stack: { node: Node; indent: number }[] = [{ node: root, indent: -1 }];
  const lines = source.replace(/^﻿/, "").split(/\r?\n/);

  lines.forEach((raw, i) => {
    const line = i + 1;
    if (/^ *\t/.test(raw)) throw new CrubalError("indent with spaces, not tabs", line);
    const stripped = stripComment(raw);
    if (!stripped.trim()) return;
    let indent = stripped.length - stripped.trimStart().length;
    let body = stripped.trim();

    while (stack.length > 1 && (stack.at(-1)?.indent ?? -1) >= indent) stack.pop();
    const parent = stack.at(-1)?.node ?? root;

    if (body === "-" || body.startsWith("- ")) {
      const item: Node = { kind: "item", key: null, value: "", text: body, line, indent, children: [] };
      parent.children.push(item);
      stack.push({ node: item, indent });
      const rest = body.slice(1).trimStart();
      if (!rest) return;
      // The item's own text: a pair starts the item's first child, so lines indented to its column join
      // the same item; anything else is the item's value.
      indent += stripped.trimStart().indexOf(rest, 1);
      body = rest;
      const first = lineNode(body, line, indent);
      if (first.kind === "line" || body.startsWith("[")) {
        item.value = body;
        return;
      }
      item.children.push(first);
      stack.push({ node: first, indent });
      return;
    }

    const node = lineNode(body, line, indent);
    parent.children.push(node);
    stack.push({ node, indent });
  });
  return root.children;
}
