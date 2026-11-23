// main.ts is mend, the CLI SPEC.md specifies (MIT). It implements the whole of SPEC.md: the command line, the
// output and exit codes, safe paths, format detection, the three-tier line matching of section 5, unified diffs
// (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the
// all-or-nothing write of section 10. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, as (old path, new path), for the report's R lines (section 2). */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A file as lines: its own line break, its lines, and whether it ends with a break (section 3). */
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(f: FileLines): string {
  return f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.final ? f.br : '');
}

/** A line of a hunk or chunk body: context, old or new, with the text after its marker. */
interface BodyItem {
  kind: ' ' | '-' | '+';
  text: string;
}

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => trimTrail(s.replace(/^[ \t]+/, ''));
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function tierEq(a: string, b: string, tier: number): boolean {
  return tier === 0 ? a === b : tier === 1 ? trimTrail(a) === trimTrail(b) : trimBoth(a) === trimBoth(b);
}

/** Every 0-based position at or after `from` where O's lines match the file's lines at `tier` (section 5). */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, from); i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!tierEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Match {
  tier: number;
  occ: number[];
}

/** The first tier with an occurrence of O at or after `from`, and its occurrences; null when O occurs nowhere. */
function matchLines(lines: string[], o: string[], strict: boolean, from = 0): Match | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const occ = occurrences(lines, o, tier, from);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/**
 * The lines a match writes (section 5): a context line is the file's own matched line; any other line of N is the
 * patch's, re-indented at tier 2 (the leading whitespace P of O's first line becomes the file's F).
 */
function writtenLines(lines: string[], pos: number, o: string[], items: BodyItem[], tier: number): string[] {
  const f = tier === 2 && o.length > 0 ? leadWs(lines[pos]!) : '';
  const p = tier === 2 && o.length > 0 ? leadWs(o[0]!) : '';
  const out: string[] = [];
  let oi = 0;
  for (const it of items) {
    if (it.kind === '-') {
      oi += 1;
      continue;
    }
    if (it.kind === ' ') {
      out.push(lines[pos + oi]!);
      oi += 1;
      continue;
    }
    let s = it.text;
    if (tier === 2 && s.trim() !== '' && s.startsWith(p)) s = f + s.slice(p.length);
    out.push(s);
  }
  return out;
}

// ---------- unified diffs (section 6) ----------

/** A raw hunk body line while parsing: a `\` marker line, or a line that was empty in the patch. */
interface RawItem {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  empty: boolean;
}

interface Hunk {
  a: number;
  items: RawItem[];
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path a `--- ` or `+++ ` line names: up to the first tab, spaces removed, `/dev/null` is no file, a/ b/ removed. */
function headerPath(raw: string): string | null {
  const s = raw.split('\t')[0]!.replace(/^ +| +$/g, '');
  if (s === '/dev/null') return null;
  return s.startsWith('a/') || s.startsWith('b/') ? s.slice(2) : s;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:[ \t].*)?$/;

/** Whether a `\` line follows the hunk's last context or `+` line. */
function backslashAfter(items: RawItem[]): boolean {
  let last = -1;
  items.forEach((it, i) => {
    if (it.kind === ' ' || it.kind === '+') last = i;
  });
  return last >= 0 && items[last + 1]?.kind === '\\';
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let hunk: Hunk | null = null;
  const newSection = (): Section => ({
    gitOld: null,
    gitNew: null,
    pairOld: undefined,
    pairNew: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  const endHunk = (): void => {
    if (hunk === null) return;
    while (hunk.items.length > 0 && hunk.items[hunk.items.length - 1]!.empty) hunk.items.pop();
    hunk = null;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (hunk !== null) {
      const next = lines[i + 1] ?? '';
      const ends =
        line.startsWith('diff --git ') ||
        (line.startsWith('--- ') && next.startsWith('+++ ')) ||
        !(line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\') || line === '');
      if (!ends) {
        if (line === '') hunk.items.push({ kind: ' ', text: '', empty: true });
        else hunk.items.push({ kind: line[0] as RawItem['kind'], text: line.slice(1), empty: false });
        i += 1;
        continue;
      }
      endHunk();
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = newSection();
      sec.gitOld = m[1]!;
      sec.gitNew = m[2]!;
      sections.push(sec);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a: Number(m[1]), items: [] };
      sec.hunks.push(hunk);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        if (sec === null || sec.hunks.length > 0) {
          sec = newSection();
          sections.push(sec);
        }
        sec.pairOld = headerPath(line.slice(4));
        sec.pairNew = headerPath(next.slice(4));
        i += 2;
        continue;
      }
      if (sec !== null && sec.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      if (line.startsWith('rename from ')) sec.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) sec.newFile = true;
      else if (line.startsWith('deleted file mode')) sec.deletedFile = true;
    }
    i += 1;
  }
  endHunk();
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  const oldPath = sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.gitOld;
  const newPath = sec.pairNew !== undefined ? sec.pairNew : sec.renameTo !== undefined ? sec.renameTo : sec.gitNew;
  const creation = sec.newFile || sec.pairOld === null;
  const deletion = sec.deletedFile || sec.pairNew === null;
  return (tree) => {
    if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (creation && newPath !== null) {
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plus: string[] = [];
      let lastPlus: { h: number; i: number } | null = null;
      sec.hunks.forEach((h, hi) => {
        h.items.forEach((it, ii) => {
          if (it.kind === '+') {
            plus.push(it.text);
            lastPlus = { h: hi, i: ii };
          }
        });
      });
      const noBreak = lastPlus !== null && sec.hunks[lastPlus.h]!.items[lastPlus.i + 1]?.kind === '\\';
      tree.now.set(newPath, joinFile({ lines: plus, br: '\n', final: !noBreak }));
      return;
    }
    if (deletion && oldPath !== null) {
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (oldPath === null || newPath === null) return;
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    const move = oldPath !== newPath;
    if (move && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    const f = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const o: string[] = [];
      for (const it of h.items) if (it.kind === ' ' || it.kind === '-') o.push(it.text);
      if (o.length === 0) {
        const n = h.items.filter((it) => it.kind === '+').map((it) => it.text);
        const at = Math.max(0, Math.min(h.a + d, f.lines.length));
        const atEnd = at === f.lines.length;
        f.lines.splice(at, 0, ...n);
        d += n.length;
        if (atEnd) f.final = !backslashAfter(h.items);
      } else {
        const m = matchLines(f.lines, o, strict);
        if (m === null) throw new Fail('no-match', oldPath);
        const target = h.a - 1 + d;
        let pos = m.occ[0]!;
        for (const cand of m.occ) if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
        const items = h.items.filter((it): it is BodyItem => it.kind !== '\\');
        const n = writtenLines(f.lines, pos, o, items, m.tier);
        const atEnd = pos + o.length === f.lines.length;
        f.lines.splice(pos, o.length, ...n);
        d += n.length - o.length;
        if (atEnd) f.final = !backslashAfter(h.items);
      }
    }
    const text = joinFile(f);
    if (move) {
      tree.now.set(oldPath, null);
      tree.now.set(newPath, text);
      tree.moves.push([oldPath, newPath]);
    } else {
      tree.now.set(newPath, text);
    }
  };
}

// ---------- SEARCH/REPLACE blocks (section 7) ----------

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let scanFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j >= scanFrom; j -= 1) {
      const l = lines[j]!;
      if (blank(l) || l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    let eq = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rp = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rp = j;
        break;
      }
    }
    if (rp < 0) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(srEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rp), strict));
    prevPath = path;
    scanFrom = rp + 1;
    i = rp + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, joinFile({ lines: newLines, br: '\n', final: true }));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const m = matchLines(f.lines, oldLines, strict);
    if (m === null) throw new Fail('no-match', path);
    if (m.occ.length > 1) throw new Fail('ambiguous', path);
    const items = newLines.map((text): BodyItem => ({ kind: '+', text }));
    const n = writtenLines(f.lines, m.occ[0]!, oldLines, items, m.tier);
    f.lines.splice(m.occ[0]!, oldLines.length, ...n);
    tree.now.set(path, joinFile(f));
  };
}

// ---------- V4A patches (section 8) ----------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const fb = lines.findIndex((l) => !blank(l));
  if (fb < 0) throw new Exit2('error: parse 1');
  if (lines[fb]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${fb + 1}`);
  let lb = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      lb = k;
      break;
    }
  }
  if (lines[lb]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isHeader = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = fb + 1;
  while (i < lb) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (!isHeader(line)) throw new Exit2(`error: parse ${i + 1}`);
    const kind = line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'delete' : 'update';
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
    const path = line.slice(prefix.length).trim();
    const startLine = i + 1;
    i += 1;
    const raw: { text: string; line: number }[] = [];
    while (i < lb && !isHeader(lines[i]!)) {
      raw.push({ text: lines[i]!, line: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const content: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) content.push(r.text.slice(1));
        else if (r.text === '') content.push('');
        else throw new Exit2(`error: parse ${r.line}`);
      }
      edits.push(v4aAdd(path, content));
    } else if (kind === 'delete') {
      for (const r of raw) if (!blank(r.text)) throw new Exit2(`error: parse ${r.line}`);
      edits.push(v4aDelete(path));
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
        idx = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let open = false;
      for (; idx < raw.length; idx += 1) {
        const r = raw[idx]!;
        const l = r.text;
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
          chunks.push(cur);
          open = true;
        } else if (l === '*** End of File') {
          if (cur === null || !open) throw new Exit2(`error: parse ${r.line}`);
          cur.eof = true;
          open = false;
        } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (cur === null) {
            cur = { anchor: null, eof: false, items: [] };
            chunks.push(cur);
            open = true;
          } else if (!open) {
            throw new Exit2(`error: parse ${r.line}`);
          }
          cur.items.push(l === '' ? { kind: ' ', text: '' } : { kind: l[0] as BodyItem['kind'], text: l.slice(1) });
        } else {
          throw new Exit2(`error: parse ${r.line}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine}`);
      edits.push(v4aUpdate(path, moveTo, chunks, strict));
    }
  }
  return edits;
}

function v4aAdd(path: string, content: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, joinFile({ lines: content, br: '\n', final: true }));
  };
}

function v4aDelete(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdate(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let found = -1;
        for (const tier of strict ? [0] : [0, 1, 2]) {
          for (let k = cursor; k < f.lines.length; k += 1) {
            if (tierEq(f.lines[k]!, ch.anchor, tier)) {
              found = k;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      const o: string[] = [];
      for (const it of ch.items) if (it.kind !== '+') o.push(it.text);
      if (o.length === 0) {
        const n = ch.items.filter((it) => it.kind === '+').map((it) => it.text);
        const at = ch.eof ? f.lines.length : Math.min(cursor, f.lines.length);
        f.lines.splice(at, 0, ...n);
        cursor = at + n.length;
      } else {
        let placed: Match & { pos: number } | null = null;
        for (const tier of strict ? [0] : [0, 1, 2]) {
          let occ = occurrences(f.lines, o, tier, cursor);
          if (ch.eof) occ = occ.filter((p) => p + o.length === f.lines.length);
          if (occ.length > 0) {
            placed = { tier, occ, pos: occ[0]! };
            break;
          }
        }
        if (placed === null) throw new Fail('no-match', path);
        const n = writtenLines(f.lines, placed.pos, o, ch.items, placed.tier);
        f.lines.splice(placed.pos, o.length, ...n);
        cursor = placed.pos + n.length;
      }
    }
    const text = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byPath = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const rowOf = new Map<string, string>();
  for (const p of [...tree.now.keys()].sort(byPath)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) rowOf.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    if (check) continue;
    if (was === now) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  for (const [o, n] of tree.moves) {
    const wasO = tree.original(o);
    const nowO = tree.now.has(o) ? tree.now.get(o)! : wasO;
    const wasN = tree.original(n);
    const nowN = tree.now.has(n) ? tree.now.get(n)! : wasN;
    if (wasO !== null && nowO === null && wasN === null && nowN !== null && rowOf.has(o) && rowOf.has(n)) {
      rowOf.delete(o);
      rowOf.set(n, `R ${o} -> ${n}`);
    }
  }
  const rows = [...rowOf.keys()].sort(byPath).map((p) => rowOf.get(p)!);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
