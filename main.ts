// mend — a command-line tool that applies an edit an AI model wrote to a tree of text files.
//
// The patch may be written in any of four formats: a unified diff, a set of SEARCH/REPLACE blocks, a V4A patch,
// or a list of text-editor tool calls in JSON. mend reads the patch, works out which format it is in (or takes
// --format), finds the lines each edit names — tolerating drifted whitespace unless --strict is given — and then
// changes every file the patch touches, or none of them: a patch that fails anywhere is reported edit by edit
// and leaves the tree exactly as it was. --check reports what would change without writing anything.
//
//     node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// PATCH is a file to read the patch from; with no PATCH (or "-") the patch comes from standard input. Everything
// is the Node standard library. The behaviour follows SPEC.md section by section, and the section numbers in the
// comments below refer to it.
//
// One more duty: when the grader runs this file it sets MAKEFUN_ENV_URL, and then main.ts is not a CLI at all —
// it hands over to the kit's runner (runner.ts, beside this file) and lets it drive. That hand-over is the block
// at the very end of the file.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** The formats --format accepts; "auto" means detect from the patch text (section 4). */
const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/**
 * A problem with the invocation or the patch as a whole (section 2): the run prints this one line on stdout and
 * exits 2, having written nothing. Thrown from anywhere in the reading phase and caught in run().
 */
class Bail {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/**
 * One edit failed (section 2): the run prints "error: <code> <path>" for it, keeps going with the later edits so
 * every failure is reported, and at the end writes nothing and exits 1. Thrown by an edit, caught per edit.
 */
class Flop {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

/** A line that is empty or only whitespace — the SPEC's "blank line". */
const isBlank = (s: string): boolean => s.trim() === '';

/**
 * A patch's lines (section 3): the text split at \n, each line with one trailing \r removed, and no empty piece
 * after a final \n. An empty patch has no lines at all.
 */
function linesOfPatch(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/**
 * A safe path (section 3): not empty, not rooted, no backslash anywhere, and no segment that is empty, "." or
 * "..". Every path an edit names is checked with this before anything else is done with it (section 10).
 */
function pathOk(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/**
 * The state of the tree while a patch is applied. Nothing reaches the disk until every edit has succeeded
 * (section 10): an edit records the new text of each path it touches in `pending` (null for a file that is to
 * be deleted), and reads see those records first and the disk second. `before()` remembers what a path held
 * before the patch, which the final report needs to tell A from M from D. `renames` collects the (old, new)
 * pair of each successful move edit, for the report's R lines (section 2).
 */
class TreeState {
  private readonly beforeCache = new Map<string, string | null>();
  readonly pending = new Map<string, string | null>();
  readonly renames: [string, string][] = [];

  /** The text a path held before the patch, or null when it did not exist (or is not a plain file). */
  before(p: string): string | null {
    if (!this.beforeCache.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.beforeCache.set(p, v);
    }
    return this.beforeCache.get(p)!;
  }

  /** The text a path holds now: what the edits so far left, or what was there before the patch. */
  current(p: string): string | null {
    return this.pending.has(p) ? this.pending.get(p)! : this.before(p);
  }
}

/** One edit of a patch: a closure that applies itself to the tree, or throws Flop. */
type ApplyEdit = (tree: TreeState) => void;

/** Which format a patch is in (section 4): the first of the four tests that holds, in this order. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const head = lines[first]!.trimStart().charAt(0);
  if (head === '[' || head === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  const looksUnified = lines.some(
    (l, idx) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ')),
  );
  return looksUnified ? 'unified' : null;
}

/**
 * A file taken apart the way section 3 describes: its line break (CRLF when the first line feed follows a
 * carriage return, LF otherwise), its lines split at that break, and whether the text ends with the break — the
 * empty piece after a final break is not a line, and an empty file has no lines and no final break.
 */
interface FileParts {
  lines: string[];
  br: string;
  endsWithBreak: boolean;
}

function takeApart(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', endsWithBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const endsWithBreak = text.endsWith(br);
  const lines = text.split(br);
  if (endsWithBreak) lines.pop();
  return { lines, br, endsWithBreak };
}

/** The inverse of takeApart: a file of no lines is written empty. */
function putTogether(f: FileParts): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.endsWithBreak ? f.br : '');
}

// ----- matching lines (section 5) -----

const stripTrailingWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBothWs = (s: string): string => stripTrailingWs(s.replace(/^[ \t]+/, ''));
const leadingWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

/** Whether two lines count as equal at a tier: exact at 0, ignoring trailing blanks at 1, ignoring both ends at 2. */
function sameAtTier(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailingWs(a) === stripTrailingWs(b);
  return stripBothWs(a) === stripBothWs(b);
}

/** Every 0-based start position at or after `from` where the wanted lines match the file's lines at `tier`. */
function findAll(lines: string[], want: string[], tier: number, from: number): number[] {
  const hits: number[] = [];
  for (let i = Math.max(0, from); i + want.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < want.length; j += 1) {
      if (!sameAtTier(lines[i + j]!, want[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

interface Located {
  tier: number;
  hits: number[];
}

/**
 * The first tier at which the wanted lines occur at or after `from`, with all of that tier's occurrences — or
 * null when they occur at no tier. --strict tries tier 0 only.
 */
function locate(lines: string[], want: string[], strict: boolean, from = 0): Located | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const hits = findAll(lines, want, tier, from);
    if (hits.length > 0) return { tier, hits };
  }
  return null;
}

/** One line of a hunk or chunk body: a context line (' '), an old line ('-') or a new line ('+'). */
interface BodyLine {
  mark: ' ' | '-' | '+';
  text: string;
}

/**
 * The lines a match writes back (section 5). The body interleaves old and new lines: an old line is dropped, a
 * context line is written as the file's own matched line (never the patch's spelling of it), and a new line is
 * the patch's — except at tier 2, where a new line that carries the old block's indentation P has P swapped for
 * the file's own indentation F, so an edit the model indented differently still lands at the file's depth. A new
 * line that is empty or all whitespace is never re-indented.
 */
function renderReplacement(fileLines: string[], at: number, oldLines: string[], body: BodyLine[], tier: number): string[] {
  const fileIndent = tier === 2 && oldLines.length > 0 ? leadingWs(fileLines[at]!) : '';
  const patchIndent = tier === 2 && oldLines.length > 0 ? leadingWs(oldLines[0]!) : '';
  const out: string[] = [];
  let consumed = 0; // how many of the matched old lines the body has walked past
  for (const bl of body) {
    if (bl.mark === '-') {
      consumed += 1;
    } else if (bl.mark === ' ') {
      out.push(fileLines[at + consumed]!);
      consumed += 1;
    } else {
      let s = bl.text;
      if (tier === 2 && s.trim() !== '' && s.startsWith(patchIndent)) s = fileIndent + s.slice(patchIndent.length);
      out.push(s);
    }
  }
  return out;
}

// ----- JSON edits (section 9) -----

/**
 * Turn one parsed JSON value into an edit, or return null when it is not a well-formed edit object: a string
 * `path`, a known `command`, and that command's keys of the right types. Keys beyond the ones a command uses
 * are ignored. A wrong command or a missing or mistyped key is a parse fault, which the caller reports.
 */
function jsonToEdit(v: unknown): ApplyEdit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  // The file an edit works on must have a safe path and exist; both failures are the edit's, in that order.
  const mustExist = (tree: TreeState): string => {
    if (!pathOk(p)) throw new Flop('unsafe', p);
    const t = tree.current(p);
    if (t === null) throw new Flop('missing', p);
    return t;
  };

  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!pathOk(p)) throw new Flop('unsafe', p);
      if (tree.current(p) !== null) throw new Flop('exists', p);
      tree.pending.set(p, text); // a create writes file_text byte for byte
    };
  }

  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? ''; // an absent new_str is the empty string
    return (tree) => {
      const before = mustExist(tree);
      // In a CRLF file the text and both strings are read with every \r\n as \n, and the result written back
      // with \r\n. The match itself is exact — no tier applies here.
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1; // occurrences may overlap
      if (count === 0) throw new Flop('no-match', p);
      if (count > 1) throw new Flop('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.pending.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = linesOfPatch(o.new_str); // new_str's lines, split the way a patch's lines are
    return (tree) => {
      const before = mustExist(tree);
      const f = takeApart(before);
      if (line < 0 || line > f.lines.length) throw new Flop('no-match', p);
      f.lines.splice(line, 0, ...add); // after line `insert_line`; 0 is the top; the final break stays as it was
      tree.pending.set(p, putTogether(f));
    };
  }

  return null;
}

/**
 * Read a JSON patch: either one array of edit objects, or JSON Lines with one object per line and blank lines
 * ignored. In array form every fault is reported at the line where the array starts; in JSON Lines form a bad
 * line is reported at its own line.
 */
function readJsonEdits(text: string, lines: string[]): ApplyEdit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Bail('error: parse 1');
  const edits: ApplyEdit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Bail(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Bail(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonToEdit(x);
      if (e === null) throw new Bail(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: ApplyEdit | null = null;
    try {
      e = jsonToEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Bail(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ----- unified diffs (section 6) -----

/**
 * One raw line of a hunk body as it was read: its marker (' ', '-', '+' or the '\' of a "\ No newline" line),
 * the text after the marker, and whether the patch line was empty (an empty line is a context line whose text
 * is empty — and empty lines at the end of a body are not part of it).
 */
interface RawBodyLine {
  mark: ' ' | '-' | '+' | '\\';
  text: string;
  wasEmpty: boolean;
}

interface Hunk {
  /** The A of the @@ header: where the hunk claims its old lines start (1-based). */
  a: number;
  body: RawBodyLine[];
}

interface DiffSection {
  gitOld: string | null; // paths from the diff --git line
  gitNew: string | null;
  pairOld: string | null | undefined; // paths from --- / +++: undefined = no pair, null = /dev/null
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path a --- or +++ line names: up to the first tab, surrounding spaces removed, /dev/null is no file, a leading a/ or b/ comes off. */
function pathFromHeader(raw: string): string | null {
  const s = raw.split('\t')[0]!.replace(/^ +| +$/g, '');
  if (s === '/dev/null') return null;
  return s.startsWith('a/') || s.startsWith('b/') ? s.slice(2) : s;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:[ \t].*)?$/;

/** Whether a '\' line follows the body's last context or '+' line — that is what takes the final break away. */
function noBreakMarker(body: RawBodyLine[]): boolean {
  let last = -1;
  body.forEach((bl, i) => {
    if (bl.mark === ' ' || bl.mark === '+') last = i;
  });
  return last >= 0 && body[last + 1]?.mark === '\\';
}

function readUnified(lines: string[], strict: boolean): ApplyEdit[] {
  const sections: DiffSection[] = [];
  let sec: DiffSection | null = null;
  let hunk: Hunk | null = null;

  const freshSection = (): DiffSection => ({
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
  const closeHunk = (): void => {
    if (hunk === null) return;
    while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.wasEmpty) hunk.body.pop();
    hunk = null;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    if (hunk !== null) {
      // Inside a hunk body: a line belongs to the body while it starts with ' ', '-', '+', '\' or is empty.
      // The body ends at any other line, at a diff --git line, or at a --- line followed by a +++ line.
      const next = lines[i + 1] ?? '';
      const bodyEnds =
        line.startsWith('diff --git ') ||
        (line.startsWith('--- ') && next.startsWith('+++ ')) ||
        !(line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\') || line === '');
      if (!bodyEnds) {
        if (line === '') hunk.body.push({ mark: ' ', text: '', wasEmpty: true });
        else hunk.body.push({ mark: line[0] as RawBodyLine['mark'], text: line.slice(1), wasEmpty: false });
        i += 1;
        continue;
      }
      closeHunk(); // fall through: the line that ended the body is read again below, as a header line
    }

    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Bail(`error: parse ${i + 1}`);
      sec = freshSection();
      sec.gitOld = m[1]!;
      sec.gitNew = m[2]!;
      sections.push(sec);
      i += 1;
      continue;
    }

    if (line.startsWith('@@')) {
      if (sec === null) throw new Bail(`error: parse ${i + 1}`); // a hunk before any section
      const m = HUNK_HEADER.exec(line);
      if (m === null) throw new Bail(`error: parse ${i + 1}`);
      hunk = { a: Number(m[1]), body: [] };
      sec.hunks.push(hunk);
      i += 1;
      continue;
    }

    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        // A --- / +++ pair opens a new section unless the current one is still in its header.
        if (sec === null || sec.hunks.length > 0) {
          sec = freshSection();
          sections.push(sec);
        }
        sec.pairOld = pathFromHeader(line.slice(4));
        sec.pairNew = pathFromHeader(next.slice(4));
        i += 2;
        continue;
      }
      // A --- line with no +++ after it, inside a section's header, faults at the line after it; elsewhere
      // (after the hunks, or outside any section) it is just prose and ignored.
      if (sec !== null && sec.hunks.length === 0) throw new Bail(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }

    // Still in a section's header (before its first hunk): a few lines name paths or the section's kind, and
    // everything else — index, modes, similarity, prose, code fences — is ignored, as are lines outside sections.
    if (sec !== null && sec.hunks.length === 0) {
      if (line.startsWith('rename from ')) sec.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) sec.newFile = true;
      else if (line.startsWith('deleted file mode')) sec.deletedFile = true;
    }
    i += 1;
  }
  closeHunk();
  return sections.map((s) => unifiedToEdit(s, strict));
}

/** The edit one unified section makes: a creation, a deletion, a move, or a change, in that reading order. */
function unifiedToEdit(sec: DiffSection, strict: boolean): ApplyEdit {
  const oldPath = sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.gitOld;
  const newPath = sec.pairNew !== undefined ? sec.pairNew : sec.renameTo !== undefined ? sec.renameTo : sec.gitNew;
  const isCreation = sec.newFile || sec.pairOld === null;
  const isDeletion = sec.deletedFile || sec.pairNew === null;
  return (tree) => {
    if (oldPath !== null && !pathOk(oldPath)) throw new Flop('unsafe', oldPath);
    if (newPath !== null && !pathOk(newPath)) throw new Flop('unsafe', newPath);

    if (isCreation && newPath !== null) {
      if (tree.current(newPath) !== null) throw new Flop('exists', newPath);
      // The created file is the '+' lines of all the section's hunks, in order, with LF breaks; it ends with a
      // break unless a '\' line follows its last '+' line.
      const plus: string[] = [];
      let lastPlus: { h: number; j: number } | null = null;
      sec.hunks.forEach((h, hi) => {
        h.body.forEach((bl, j) => {
          if (bl.mark === '+') {
            plus.push(bl.text);
            lastPlus = { h: hi, j };
          }
        });
      });
      const noBreak = lastPlus !== null && sec.hunks[lastPlus.h]!.body[lastPlus.j + 1]?.mark === '\\';
      tree.pending.set(newPath, putTogether({ lines: plus, br: '\n', endsWithBreak: !noBreak }));
      return;
    }

    if (isDeletion && oldPath !== null) {
      if (tree.current(oldPath) === null) throw new Flop('missing', oldPath);
      tree.pending.set(oldPath, null); // a deletion's hunks are not read
      return;
    }

    if (oldPath === null || newPath === null) return; // nothing the section can act on

    const before = tree.current(oldPath);
    if (before === null) throw new Flop('missing', oldPath);
    const isMove = oldPath !== newPath;
    if (isMove && tree.current(newPath) !== null) throw new Flop('exists', newPath);

    // The hunks apply in order, each to the result of the ones before it. `shift` is the running total of
    // (new length - old length) over the hunks applied so far, which corrects the header's line numbers.
    const f = takeApart(before);
    let shift = 0;
    for (const h of sec.hunks) {
      const oldLines: string[] = [];
      for (const bl of h.body) if (bl.mark === ' ' || bl.mark === '-') oldLines.push(bl.text);
      if (oldLines.length === 0) {
        // Nothing to match: the new lines go in after the first A + shift lines (all of them, if fewer).
        const add = h.body.filter((bl) => bl.mark === '+').map((bl) => bl.text);
        const at = Math.max(0, Math.min(h.a + shift, f.lines.length));
        const atEnd = at === f.lines.length;
        f.lines.splice(at, 0, ...add);
        shift += add.length;
        if (atEnd) f.endsWithBreak = !noBreakMarker(h.body);
      } else {
        const found = locate(f.lines, oldLines, strict);
        if (found === null) throw new Flop('no-match', oldPath);
        // Of the occurrences at the tier where the lines were found, take the one nearest the position the
        // header claims (corrected by shift); of two equally near, the earlier.
        const target = h.a - 1 + shift;
        let at = found.hits[0]!;
        for (const cand of found.hits) if (Math.abs(cand - target) < Math.abs(at - target)) at = cand;
        const body = h.body.filter((bl): bl is BodyLine => bl.mark !== '\\');
        const replacement = renderReplacement(f.lines, at, oldLines, body, found.tier);
        const reachesEnd = at + oldLines.length === f.lines.length;
        f.lines.splice(at, oldLines.length, ...replacement);
        shift += replacement.length - oldLines.length;
        // A hunk whose matched lines run to the end of the file decides the final break: it stays unless a
        // '\' line follows the hunk's last context or '+' line. A hunk that does not reach the end leaves
        // the file's final break as it was.
        if (reachesEnd) f.endsWithBreak = !noBreakMarker(h.body);
      }
    }

    const text = putTogether(f);
    if (isMove) {
      tree.pending.set(oldPath, null);
      tree.pending.set(newPath, text);
      tree.renames.push([oldPath, newPath]);
    } else {
      tree.pending.set(newPath, text);
    }
  };
}

// ----- SEARCH/REPLACE blocks (section 7) -----

/**
 * Read the blocks of a SEARCH/REPLACE patch. Each block names its file on the nearest line above its SEARCH
 * marker that is not blank and does not open a code fence — searching no further back than the previous block's
 * end; a block with no such line of its own takes the previous block's path, and the first block with neither
 * is a parse fault at its SEARCH line, as is a block whose ======= or >>>>>>> REPLACE never comes. Lines
 * outside blocks are ignored.
 */
function readSr(lines: string[], strict: boolean): ApplyEdit[] {
  const edits: ApplyEdit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0; // the path line of a block is looked for after the previous block's REPLACE line
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j >= searchFrom; j -= 1) {
      const l = lines[j]!;
      if (isBlank(l) || l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Bail(`error: parse ${s + 1}`);

    let eq = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Bail(`error: parse ${s + 1}`);
    let rp = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rp = j;
        break;
      }
    }
    if (rp < 0) throw new Bail(`error: parse ${s + 1}`);

    edits.push(srToEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rp), strict));
    prevPath = path;
    searchFrom = rp + 1;
    i = rp + 1;
  }
  return edits;
}

/** One SEARCH/REPLACE block as an edit: an empty old side creates the file; otherwise the old lines must occur exactly once. */
function srToEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): ApplyEdit {
  return (tree) => {
    if (!pathOk(path)) throw new Flop('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.current(path) !== null) throw new Flop('exists', path);
      tree.pending.set(path, putTogether({ lines: newLines, br: '\n', endsWithBreak: true }));
      return;
    }
    const before = tree.current(path);
    if (before === null) throw new Flop('missing', path);
    const f = takeApart(before);
    const found = locate(f.lines, oldLines, strict);
    if (found === null) throw new Flop('no-match', path);
    if (found.hits.length > 1) throw new Flop('ambiguous', path);
    const body = newLines.map((text): BodyLine => ({ mark: '+', text }));
    const replacement = renderReplacement(f.lines, found.hits[0]!, oldLines, body, found.tier);
    f.lines.splice(found.hits[0]!, oldLines.length, ...replacement);
    tree.pending.set(path, putTogether(f));
  };
}

// ----- V4A patches (section 8) -----

/** One chunk of an Update File section: an optional anchor line, whether *** End of File pins it to the file's end, and its body. */
interface Chunk {
  anchor: string | null;
  atEof: boolean;
  body: BodyLine[];
}

function readV4a(lines: string[], strict: boolean): ApplyEdit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Bail('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Bail(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Bail(`error: parse ${lines.length + 1}`);

  const isSectionHead = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

  const edits: ApplyEdit[] = [];
  let i = first + 1;
  while (i < last) {
    const head = lines[i]!;
    if (isBlank(head)) {
      i += 1; // blank lines between sections are ignored
      continue;
    }
    if (!isSectionHead(head)) throw new Bail(`error: parse ${i + 1}`);
    const kind = head.startsWith('*** Add File: ') ? 'add' : head.startsWith('*** Delete File: ') ? 'delete' : 'update';
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
    const path = head.slice(prefix.length).trim();
    const headLine = i + 1;
    i += 1;
    // The section's own lines run up to the next section (or the end of the patch); blank lines at its end are
    // not part of it.
    const raw: { text: string; line: number }[] = [];
    while (i < last && !isSectionHead(lines[i]!)) {
      raw.push({ text: lines[i]!, line: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && isBlank(raw[raw.length - 1]!.text)) raw.pop();

    if (kind === 'add') {
      const content: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) content.push(r.text.slice(1));
        else if (r.text === '') content.push(''); // an empty line is an empty line of the file
        else throw new Bail(`error: parse ${r.line}`);
      }
      edits.push(v4aAdd(path, content));
    } else if (kind === 'delete') {
      for (const r of raw) if (!isBlank(r.text)) throw new Bail(`error: parse ${r.line}`); // a Delete section has no lines
      edits.push(v4aDelete(path));
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
        idx = 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      let open = false; // whether the current chunk is still taking body lines (*** End of File closes it)
      for (; idx < raw.length; idx += 1) {
        const r = raw[idx]!;
        const l = r.text;
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, atEof: false, body: [] };
          chunks.push(cur);
          open = true;
        } else if (l === '*** End of File') {
          if (cur === null || !open) throw new Bail(`error: parse ${r.line}`);
          cur.atEof = true;
          open = false;
        } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (cur === null) {
            cur = { anchor: null, atEof: false, body: [] };
            chunks.push(cur);
            open = true;
          } else if (!open) {
            throw new Bail(`error: parse ${r.line}`);
          }
          cur.body.push(l === '' ? { mark: ' ', text: '' } : { mark: l[0] as BodyLine['mark'], text: l.slice(1) });
        } else {
          throw new Bail(`error: parse ${r.line}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Bail(`error: parse ${headLine}`);
      edits.push(v4aUpdate(path, moveTo, chunks, strict));
    }
  }
  return edits;
}

function v4aAdd(path: string, content: string[]): ApplyEdit {
  return (tree) => {
    if (!pathOk(path)) throw new Flop('unsafe', path);
    if (tree.current(path) !== null) throw new Flop('exists', path);
    tree.pending.set(path, putTogether({ lines: content, br: '\n', endsWithBreak: true })); // an added file ends with a break
  };
}

function v4aDelete(path: string): ApplyEdit {
  return (tree) => {
    if (!pathOk(path)) throw new Flop('unsafe', path);
    if (tree.current(path) === null) throw new Flop('missing', path);
    tree.pending.set(path, null);
  };
}

function v4aUpdate(path: string, moveTo: string | null, chunks: Chunk[], strict: boolean): ApplyEdit {
  return (tree) => {
    if (!pathOk(path)) throw new Flop('unsafe', path);
    if (moveTo !== null && !pathOk(moveTo)) throw new Flop('unsafe', moveTo);
    const before = tree.current(path);
    if (before === null) throw new Flop('missing', path);
    if (moveTo !== null && tree.current(moveTo) !== null) throw new Flop('exists', moveTo);
    const f = takeApart(before);
    // The chunks apply in order behind a cursor that only moves forward through the file, so two chunks can
    // never reach back over lines an earlier chunk has already settled.
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        // The anchor is one line: the first line at or after the cursor equal to it, at the first tier that
        // has one. The cursor moves past it, and the chunk's own lines are looked for from there.
        let found = -1;
        for (const tier of strict ? [0] : [0, 1, 2]) {
          for (let k = cursor; k < f.lines.length; k += 1) {
            if (sameAtTier(f.lines[k]!, ch.anchor, tier)) {
              found = k;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Flop('no-match', path);
        cursor = found + 1;
      }
      const oldLines: string[] = [];
      for (const bl of ch.body) if (bl.mark !== '+') oldLines.push(bl.text);
      if (oldLines.length === 0) {
        const add = ch.body.filter((bl) => bl.mark === '+').map((bl) => bl.text);
        const at = ch.atEof ? f.lines.length : Math.min(cursor, f.lines.length);
        f.lines.splice(at, 0, ...add);
        cursor = at + add.length;
      } else {
        // The first occurrence of the old lines at or after the cursor, at the first tier that has one; an
        // end-of-file chunk takes only an occurrence that ends at the file's last line.
        let placed: (Located & { at: number }) | null = null;
        for (const tier of strict ? [0] : [0, 1, 2]) {
          let hits = findAll(f.lines, oldLines, tier, cursor);
          if (ch.atEof) hits = hits.filter((pos) => pos + oldLines.length === f.lines.length);
          if (hits.length > 0) {
            placed = { tier, hits, at: hits[0]! };
            break;
          }
        }
        if (placed === null) throw new Flop('no-match', path);
        const replacement = renderReplacement(f.lines, placed.at, oldLines, ch.body, placed.tier);
        f.lines.splice(placed.at, oldLines.length, ...replacement);
        cursor = placed.at + replacement.length; // just after the lines written
      }
    }
    const text = putTogether(f);
    if (moveTo !== null) {
      tree.pending.set(path, null);
      tree.pending.set(moveTo, text);
      tree.renames.push([path, moveTo]);
    } else {
      tree.pending.set(path, text);
    }
  };
}

// ----- the run: command line, applying the edits, reporting (sections 1, 2 and 10) -----

function run(args: string[]): { code: number; out: string[] } {
  // Section 1: the options and at most one positional argument, in any order; "--" ends the options, and a
  // lone "-" is a positional (it means standard input). An argument that starts with "-" and is none of the
  // options, an option given twice, a --format value outside the five names, or a second positional are all
  // usage errors — and a usage error wins over everything else.
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const positional: string[] = [];
  let optionsEnded = false;
  for (const a of args) {
    if (!optionsEnded && a === '--') optionsEnded = true;
    else if (!optionsEnded && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !checkOnly) checkOnly = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else positional.push(a);
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };

  const patchFile = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let patchText = '';
  try {
    patchText = readFileSync(patchFile ?? 0, 'utf8'); // descriptor 0 is standard input
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = linesOfPatch(patchText);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  // Reading the patch comes before any file is looked at, so a parse error is reported ahead of every other
  // outcome. A patch in which the reader finds no edit at all is "error: parse 1".
  let edits: ApplyEdit[];
  try {
    edits =
      kind === 'json'
        ? readJsonEdits(patchText, lines)
        : kind === 'unified'
          ? readUnified(lines, strict)
          : kind === 'search-replace'
            ? readSr(lines, strict)
            : readV4a(lines, strict);
    if (edits.length === 0) throw new Bail('error: parse 1');
  } catch (e) {
    if (e instanceof Bail) return { code: 2, out: [e.line] };
    throw e;
  }

  // Section 10: the edits apply in the patch's order, each to the tree as the earlier ones left it. A failed
  // edit changes nothing — its writes and its renames are rolled back — and the edits after it still run, so
  // every failure is reported. If any edit failed, nothing is written at all.
  const tree = new TreeState();
  const failures: Flop[] = [];
  for (const edit of edits) {
    const pendingBefore = new Map(tree.pending);
    const renamesBefore = tree.renames.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Flop)) throw e;
      tree.pending.clear();
      for (const [k, v] of pendingBefore) tree.pending.set(k, v);
      tree.renames.length = renamesBefore;
      failures.push(e);
    }
  }
  if (failures.length > 0) {
    return {
      code: 1,
      out: [...failures.map((f) => `error: ${f.code} ${f.path}`), `failed: ${failures.length} of ${edits.length} edits`],
    };
  }

  // Every edit succeeded: write the tree (unless --check), and report one line per path whose state changed,
  // in byte order of the paths. A file whose bytes are what they were is neither written nor listed.
  const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const rowByPath = new Map<string, string>();
  for (const p of [...tree.pending.keys()].sort(byBytes)) {
    const was = tree.before(p);
    const now = tree.pending.get(p)!;
    if (was !== now) rowByPath.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    if (checkOnly || was === now) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  // A successful move replaces its pair's D and A lines with one R line, sorted by the new path — provided the
  // move's shape survived the whole patch: the old path existed before and is gone now, the new one the reverse.
  for (const [oldP, newP] of tree.renames) {
    const wasOld = tree.before(oldP);
    const nowOld = tree.pending.has(oldP) ? tree.pending.get(oldP)! : wasOld;
    const wasNew = tree.before(newP);
    const nowNew = tree.pending.has(newP) ? tree.pending.get(newP)! : wasNew;
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null && rowByPath.has(oldP) && rowByPath.has(newP)) {
      rowByPath.delete(oldP);
      rowByPath.set(newP, `R ${oldP} -> ${newP}`);
    }
  }
  const rows = [...rowByPath.keys()].sort(byBytes).map((p) => rowByPath.get(p)!);
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
