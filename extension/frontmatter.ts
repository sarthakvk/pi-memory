/**
 * Dependency-free frontmatter parsing.
 *
 * A delimiter split followed by normalisation. Supports the subset of YAML
 * that memory files actually use:
 * scalars, one level of nested mapping, quoted and bare strings, booleans,
 * numbers, null. Anything it cannot parse degrades to "no frontmatter" rather
 * than throwing.
 */

/** The leading `---` … `---` block that opens a memory file. */
const DELIMITER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/;

/** `name:` must be a kebab/snake-case slug. */
export const NAME_PATTERN = /^[a-z0-9_-]+$/;

export type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue };

export interface Frontmatter {
  /** `name:` if it is a non-empty string, else null. */
  name: string | null;
  /** `description:` if it is a non-empty string, else null. */
  description: string | null;
  /**
   * `metadata:` merged over any unrecognised top-level keys.
   *
   * Every top-level key other than
   * name/description/metadata whose value is non-null is folded into metadata,
   * then the explicit `metadata` mapping is spread on top of it. So a
   * top-level `pinned: true` works exactly like `metadata.pinned: true`.
   */
  metadata: Record<string, YamlValue>;
  /** True when the leading `---` delimiter was present and well-formed. */
  present: boolean;
}

export interface ParsedFile {
  frontmatter: Frontmatter;
  body: string;
}

const EMPTY: Frontmatter = { name: null, description: null, metadata: {}, present: false };

function emptyFrontmatter(): Frontmatter {
  return { name: null, description: null, metadata: {}, present: false };
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function isPlainObject(v: unknown): v is Record<string, YamlValue> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Strip a trailing unquoted `#` comment. Quoted values keep their hashes. */
function stripComment(raw: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(raw[i - 1]))) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

function parseScalar(raw: string): YamlValue {
  const t = stripComment(raw).trim();
  if (t === "") return "";
  if (
    (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
    (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
  ) {
    return t.slice(1, -1);
  }
  if (t === "true" || t === "True" || t === "TRUE") return true;
  if (t === "false" || t === "False" || t === "FALSE") return false;
  if (t === "null" || t === "~" || t === "Null" || t === "NULL") return null;
  if (/^-?\d+$/.test(t)) return Number.parseInt(t, 10);
  if (/^-?\d*\.\d+$/.test(t)) return Number.parseFloat(t);
  return t;
}

interface Line {
  indent: number;
  key: string;
  rest: string;
  listItem: boolean;
}

function tokenize(src: string): Line[] {
  const out: Line[] = [];
  for (const rawLine of src.split(/\r?\n/)) {
    if (rawLine.trim() === "" || rawLine.trim().startsWith("#")) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const trimmed = rawLine.trim();
    if (trimmed.startsWith("- ") || trimmed === "-") {
      out.push({ indent, key: "", rest: trimmed.slice(1).trim(), listItem: true });
      continue;
    }
    const colon = trimmed.indexOf(":");
    if (colon < 0) continue;
    out.push({
      indent,
      key: trimmed.slice(0, colon).trim(),
      rest: trimmed.slice(colon + 1),
      listItem: false,
    });
  }
  return out;
}

function parseBlock(lines: Line[], start: number, indent: number): [Record<string, YamlValue>, number] {
  const obj: Record<string, YamlValue> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent || line.listItem) {
      i++;
      continue;
    }
    const valueText = stripComment(line.rest).trim();
    if (valueText === "") {
      const next = lines[i + 1];
      if (next && next.indent > indent && next.listItem) {
        const items: YamlValue[] = [];
        let j = i + 1;
        while (j < lines.length && lines[j].indent > indent && lines[j].listItem) {
          items.push(parseScalar(lines[j].rest));
          j++;
        }
        obj[line.key] = items;
        i = j;
        continue;
      }
      if (next && next.indent > indent) {
        const [nested, consumed] = parseBlock(lines, i + 1, next.indent);
        obj[line.key] = nested;
        i = consumed;
        continue;
      }
      obj[line.key] = "";
      i++;
      continue;
    }
    obj[line.key] = parseScalar(line.rest);
    i++;
  }
  return [obj, i];
}

/** Parse a YAML-subset document into a plain object. Never throws. */
export function parseYamlSubset(src: string): Record<string, YamlValue> {
  try {
    const lines = tokenize(src);
    if (lines.length === 0) return {};
    const base = Math.min(...lines.map((l) => l.indent));
    return parseBlock(lines, 0, base)[0];
  } catch {
    return {};
  }
}

/**
 * Split a memory file into frontmatter and body.
 *
 * A file with no leading `---` block, or with a block that fails to parse,
 * yields empty frontmatter and the whole file as body.
 */
export function parseMemoryFile(content: string): ParsedFile {
  const match = DELIMITER.exec(content);
  if (!match) return { frontmatter: emptyFrontmatter(), body: content };

  const raw = parseYamlSubset(match[1] ?? "");
  const body = content.slice(match[0].length);

  const metadata: Record<string, YamlValue> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "name" || k === "description" || k === "metadata") continue;
    if (v === null || v === undefined) continue;
    metadata[k] = v;
  }
  if (isPlainObject(raw.metadata)) Object.assign(metadata, raw.metadata);

  return {
    frontmatter: {
      name: stringOrNull(raw.name),
      description: stringOrNull(raw.description),
      metadata,
      present: true,
    },
    body,
  };
}

export { EMPTY as EMPTY_FRONTMATTER };
