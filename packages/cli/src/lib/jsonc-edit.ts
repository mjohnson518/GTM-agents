// GTM-agents: surgical edits to JSONC text. It finds the exact source span of every string value,
// keyed by its path, and replaces values in place, so comments, spacing, key order and trailing
// commas survive an edit. Nothing is ever re-serialized.

export type JsonPathPart = string | number;

export interface StringSpan {
  path: JsonPathPart[];
  /** Offset of the opening quote. */
  start: number;
  /** Offset just past the closing quote. */
  end: number;
  value: string;
}

export interface Replacement {
  start: number;
  end: number;
  value: string;
}

/** Every string value in a JSONC document (object keys excluded), with its path and source span. */
export function stringSpans(text: string): StringSpan[] {
  const spans: StringSpan[] = [];
  let i = 0;
  const fail = (message: string): never => {
    throw new SyntaxError(`${message} at offset ${i}`);
  };

  const skip = (): void => {
    for (;;) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        i++;
      } else if (c === "/" && text[i + 1] === "/") {
        while (i < text.length && text[i] !== "\n") i++;
      } else if (c === "/" && text[i + 1] === "*") {
        const close = text.indexOf("*/", i + 2);
        if (close === -1) fail("unterminated /* comment");
        i = close + 2;
      } else {
        return;
      }
    }
  };

  const readString = (): { start: number; end: number; value: string } => {
    const start = i;
    if (text[i] !== '"') fail("expected a string");
    i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") i++;
      if (text[i] === "\n") fail("line break inside a string");
      i++;
    }
    if (i >= text.length) fail("unterminated string");
    i++;
    return { start, end: i, value: JSON.parse(text.slice(start, i)) as string };
  };

  const parseValue = (path: JsonPathPart[]): void => {
    skip();
    const c = text[i];
    if (c === "{") {
      i++;
      skip();
      while (text[i] !== "}") {
        const key = readString().value;
        skip();
        if (text[i] !== ":") fail('expected ":"');
        i++;
        parseValue([...path, key]);
        skip();
        if (text[i] === ",") {
          i++;
          skip();
        } else if (text[i] !== "}") {
          fail('expected "," or "}"');
        }
      }
      i++;
    } else if (c === "[") {
      i++;
      skip();
      let index = 0;
      while (text[i] !== "]") {
        parseValue([...path, index++]);
        skip();
        if (text[i] === ",") {
          i++;
          skip();
        } else if (text[i] !== "]") {
          fail('expected "," or "]"');
        }
      }
      i++;
    } else if (c === '"') {
      spans.push({ path, ...readString() });
    } else {
      const m = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
      if (!m) fail("unexpected token");
      i += (m as RegExpExecArray)[0].length;
    }
  };

  parseValue([]);
  skip();
  if (i < text.length) fail("unexpected content after the document");
  return spans;
}

/** Replace string values in place. Each replacement covers one span, quotes included. */
export function replaceStrings(text: string, replacements: readonly Replacement[]): string {
  const sorted = [...replacements].sort((a, b) => b.start - a.start);
  let out = text;
  let floor = Number.POSITIVE_INFINITY;
  for (const r of sorted) {
    if (r.end > floor) throw new Error("overlapping replacements");
    out = `${out.slice(0, r.start)}${JSON.stringify(r.value)}${out.slice(r.end)}`;
    floor = r.start;
  }
  return out;
}

export function pathKey(path: readonly JsonPathPart[]): string {
  return path.map((p) => (typeof p === "number" ? `[${p}]` : `.${p}`)).join("").replace(/^\./, "");
}
