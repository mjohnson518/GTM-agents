// GTM-agents: a small, strict JSONC reader for wrangler.jsonc: JSON plus // and /* */ comments
// and trailing commas. Anything else is a JSON syntax error.

/** Remove comments and trailing commas outside strings, keeping line breaks so errors keep their lines. */
export function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) throw new SyntaxError("unterminated /* comment");
      out += text.slice(i, end + 2).replace(/[^\n]/g, "");
      i = end + 1;
    } else if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] as string)) j++;
      if (text[j] === "}" || text[j] === "]") continue;
      out += c;
    } else {
      out += c;
    }
  }
  if (inString) throw new SyntaxError("unterminated string");
  return out;
}

export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonc(text)) as unknown;
}
