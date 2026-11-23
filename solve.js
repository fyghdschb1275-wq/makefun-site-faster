// Faster drop-in for makefun-site 1.0.0: run(input) returns exactly makefun-site 1.0.0's build output,
// byte for byte. v3 architecture: the Markdown renderer is a single pass over line ranges of the
// source (no token tree, no per-construct substrings; the word count is taken on the same pass),
// and templates are compiled per build to straight-line code with includes inlined (depth guards
// preserved), loop variables bound to generated locals, and scope objects materialized only where
// a non-inlined include still needs the chain. Semantics follow the reference code wherever its
// README and code differ.

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const ESC_RE = /[&<>"']/g;
const ESC_PROBE = /[&<>"']/;
const escRepl = (ch) => ESCAPES[ch];

/** `text` with & < > " and ' escaped (the reference's regex replace; V8's replace scans natively
 * and beats a hand-driven exec loop several times over on this corpus). */
function escapeHtmlRaw(text) {
  return text.replace(ESC_RE, escRepl);
}

// Per-build memo for escaped values: the same titles, excerpts and urls are escaped again on
// every page that lists them. Reset in build(); bounded to short strings.
let escCache = new Map();

/** `text` with & < > " and ' escaped (the reference's regex replace, unchanged). */
function escapeHtml(text) {
  if (text.length > 2048) return escapeHtmlRaw(text);
  const hit = escCache.get(text);
  if (hit !== undefined) return hit;
  const out = escapeHtmlRaw(text);
  escCache.set(text, out);
  return out;
}

export const SLUG_MAX = 64;

// Per-build memo tables (created fresh in build(): nothing is cached from one case to the next).
let slugCache = new Map();
let dateCache = new Map();

const SLUG_ASCII = /^[\x00-\x7F]*$/;
const SLUG_RUNS = /[A-Za-z0-9]+/g;
const SLUG_TRAIL = /-+$/;

function slugifyRaw(text) {
  // On ASCII text (NFKD is the identity there and ASCII holds no combining marks) the
  // slug is the kept runs joined by '-': the regex engine finds the runs faster than a
  // hand loop. Non-ASCII text takes the general path below.
  if (SLUG_ASCII.test(text)) {
    const runs = text.match(SLUG_RUNS);
    if (runs === null) return 'untitled';
    let out = runs.join('-').toLowerCase();
    if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX).replace(SLUG_TRAIL, '');
    return out;
  }
  let out = '';
  {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    let runStart = -1;
    for (let i = 0; i <= plain.length;) {
      const cp = i < plain.length ? plain.codePointAt(i) : 0;
      const keep = (cp >= 97 && cp <= 122) || (cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90);
      if (keep) {
        if (runStart === -1) runStart = i;
      } else if (runStart !== -1) {
        if (out !== '') out += '-';
        out += plain.slice(runStart, i).toLowerCase();
        runStart = -1;
      }
      i += cp > 0xffff ? 2 : 1;
    }
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const out = slugifyRaw(text);
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const hit = dateCache.get(date);
  if (hit !== undefined) return hit;
  let out;
  if (date.length === 10 && date.charCodeAt(4) === 45 && date.charCodeAt(7) === 45) {
    out = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
  } else {
    const [y, m, d] = date.split('-');
    out = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
  }
  dateCache.set(date, out);
  return out;
}

/** Whether char code `cc` is JavaScript's \s. */
function isSpaceCode(cc) {
  return (
    cc === 32 || (cc >= 9 && cc <= 13) || cc === 160 || cc === 5760 ||
    (cc >= 8192 && cc <= 8202) || cc === 8232 || cc === 8233 || cc === 8239 ||
    cc === 8287 || cc === 12288 || cc === 65279
  );
}

// \s as a table over all code units, built once from isSpaceCode (the exact set above).
const WS_TABLE = new Uint8Array(65536);
for (let i = 0; i < 65536; i++) WS_TABLE[i] = isSpaceCode(i) ? 1 : 0;

/** The words of a text: its runs of characters other than whitespace (counted, never listed).
 * The scan is branchless (inWord is 0/1 and the count grows by (non-space AND not-in-word)):
 * under the cold single-pass flags this measures about twice as fast as the branching form. */
function wordsOf(text) {
  let count = 0;
  let inWord = 0;
  for (let i = 0; i < text.length; i++) {
    const ws = WS_TABLE[text.charCodeAt(i)];
    count += (1 - ws) & (1 - inWord);
    inWord = 1 - ws;
  }
  return count;
}

/** The words of the line range [lo, hi) of `s` (a line holds no "\n", and "\n" is whitespace,
 * so counting line by line gives the whole text's count). */
function wordsInRange(s, lo, hi) {
  let count = 0;
  let inWord = 0;
  for (let i = lo; i < hi; i++) {
    const ws = WS_TABLE[s.charCodeAt(i)];
    count += (1 - ws) & (1 - inWord);
    inWord = 1 - ws;
  }
  return count;
}

// ---------------------------------------------------------------- front matter

export const KEYS = Object.freeze(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const KEY_SET = new Set(KEYS);

/** Whether `raw` is exactly \d{4}-\d{2}-\d{2} (the DATE grammar, read by hand). */
function isDateShape(raw) {
  if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return false;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const cc = raw.charCodeAt(i);
    if (cc < 48 || cc > 57) return false;
  }
  return true;
}

/** Whether `raw` is [a-z0-9-]+ (the NAME grammar, read by hand). */
function isNameShape(raw) {
  if (raw.length === 0) return false;
  for (let i = 0; i < raw.length; i++) {
    const cc = raw.charCodeAt(i);
    if (!((cc >= 97 && cc <= 122) || (cc >= 48 && cc <= 57) || cc === 45)) return false;
  }
  return true;
}

/** Whether `raw` is [a-z0-9]+(-[a-z0-9]+)* (the SLUG grammar, read by hand). */
function isSlugShape(raw) {
  let i = 0;
  for (;;) {
    const start = i;
    while (i < raw.length) {
      const cc = raw.charCodeAt(i);
      if ((cc >= 97 && cc <= 122) || (cc >= 48 && cc <= 57)) i++;
      else break;
    }
    if (i === start) return false;
    if (i === raw.length) return true;
    if (raw.charCodeAt(i) !== 45) return false;
    i++;
  }
}

/** Whether `t` holds none of " [ ] (the TAG grammar, read by hand). */
function isTagShape(t) {
  return !t.includes('"') && !t.includes('[') && !t.includes(']');
}

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      if (!isDateShape(raw)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      const y = Number(raw.slice(0, 4));
      const mo = Number(raw.slice(5, 7));
      const d = Number(raw.slice(8, 10));
      if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !isTagShape(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isNameShape(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlugShape(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether the line range [lo, hi) of `s` is all spaces and tabs. */
function isBlankRange(s, lo, hi) {
  for (let i = lo; i < hi; i++) {
    const c = s[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused.
 * `text` has "\n" line ends. Same checks in the same order as the reference, without splitting the body.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  if (text === '---') return { error: 'the front matter is not closed' };
  // The reference scans for the close before it reads any line, so an unclosed front matter
  // is reported ahead of every line error: pass 1 finds the closing fence (allocating
  // nothing), pass 2 reads the lines between the fences by range.
  let bodyStart = -1;
  let fenceStart = -1;
  let p = 4;
  for (;;) {
    const nl = text.indexOf('\n', p);
    const lineEnd = nl === -1 ? text.length : nl;
    if (lineEnd - p === 3 && text.charCodeAt(p) === 45 && text.charCodeAt(p + 1) === 45 && text.charCodeAt(p + 2) === 45) {
      fenceStart = p;
      bodyStart = nl === -1 ? text.length : nl + 1;
      break;
    }
    if (nl === -1) break;
    p = nl + 1;
  }
  if (bodyStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  p = 4;
  for (let j = 0; p < fenceStart; j++) {
    const nl = text.indexOf('\n', p);
    const lineEnd = nl === -1 ? text.length : nl;
    if (!isBlankRange(text, p, lineEnd) && text.charCodeAt(p) !== 35) {
      // The LINE grammar read by hand: [a-z_]+ then ':' then either the line's end or
      // one space and the rest of the line.
      let k = p;
      while (k < lineEnd) {
        const cc = text.charCodeAt(k);
        if ((cc >= 97 && cc <= 122) || cc === 95) k++;
        else break;
      }
      if (k === p || text.charCodeAt(k) !== 58) return { error: `line ${j + 2} is not "key: value"` };
      const key = text.slice(p, k);
      let raw;
      if (k + 1 === lineEnd) raw = '';
      else if (text.charCodeAt(k + 1) === 32) raw = text.slice(k + 2, lineEnd);
      else return { error: `line ${j + 2} is not "key: value"` };
      let end = raw.length;
      while (end > 0 && (raw[end - 1] === ' ' || raw[end - 1] === '\t')) end--;
      if (end !== raw.length) raw = raw.slice(0, end);
      if (!KEY_SET.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (nl === -1) break;
    p = nl + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

// The same set as a table over code units (all its members are ASCII), for the scanning loops.
const ESCAPABLE_TABLE = new Uint8Array(128);
for (const ch of ESCAPABLE) ESCAPABLE_TABLE[ch.charCodeAt(0)] = 1;

/** Whether `cc` is a character a backslash escapes. */
function isEscapable(cc) {
  return cc < 128 && ESCAPABLE_TABLE[cc] === 1;
}

/** Whether the character at `j` is consumed by a backslash escape in a scan starting at
 * `from`: the reference's scan pairs backslashes greedily from the left, so within the run of
 * backslashes ending at j - 1 (as far back as `from`) an odd count leaves the last backslash
 * unpaired, and it escapes s[j]; an even count pairs them all among themselves. */
function isEscapedAt(s, j, from) {
  let n = 0;
  let k = j - 1;
  while (k >= from && s.charCodeAt(k) === 92) {
    n++;
    k--;
  }
  return (n & 1) === 1;
}

/** The first index in [from, hi) where `s` holds `what` outside a backslash escape, or -1.
 * Candidates come from indexOf; a candidate preceded by an odd backslash run is the scan's
 * escape target and is passed over, exactly as the reference's character walk passes it. */
function findUnescaped(s, what, from, hi) {
  const wlen = what.length;
  let j = s.indexOf(what, from);
  while (j !== -1 && j + wlen <= hi) {
    if (!isEscapedAt(s, j, from)) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first single * in [from, hi) (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, hi) {
  let j = s.indexOf('*', from);
  while (j !== -1 && j < hi) {
    if (isEscapedAt(s, j, from)) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (s[j + 1] === '*') {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

// Shared scan regex for plain runs (never live across a recursive call, like ESC_SCAN).
const CONSTRUCT_SCAN = /[`*\[\\]/g;

const WS_TEST = /\s/;

/** The range [lo, hi) of `s` rendered inline, as a string; `env.link(target)` is a link's href.
 * The reference's walk over ranges instead of substrings, with plain runs batched. The result
 * is accumulated as a rope (out += piece) rather than a chunk array joined later: the pieces
 * are the same strings in the same order, so the flattened result is identical, and callers
 * that need the fragment (a heading's toc entry, a first paragraph's excerpt) no longer pay
 * a slice-and-join of a shared chunk list to recover it. */
function inlineRange(s, lo, hi, env) {
  let out = '';
  let i = lo;
  while (i < hi) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < hi && isEscapable(s.charCodeAt(i + 1))) {
      const e = s[i + 1];
      out += ESCAPES[e] ?? e;
      i += 2;
      continue;
    }
    if (c === 96) {
      let j = s.indexOf('`', i + 1);
      if (j >= hi) j = -1;
      if (j > i + 1) {
        out += '<code>';
        out += escapeHtmlRaw(s.slice(i + 1, j));
        out += '</code>';
        i = j + 1;
      } else {
        out += '`';
        i++;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2, hi);
        if (j > i + 2) {
          out += '<strong>';
          out += inlineRange(s, i + 2, j, env);
          out += '</strong>';
          i = j + 2;
        } else {
          out += '**';
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1, hi);
      if (j > i + 1) {
        out += '<em>';
        out += inlineRange(s, i + 1, j, env);
        out += '</em>';
        i = j + 1;
      } else {
        out += '*';
        i++;
      }
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1, hi);
      let m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      if (m >= hi) m = -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !WS_TEST.test(target)) {
        out += '<a href="';
        out += escapeHtml(env.link(target));
        out += '">';
        out += inlineRange(s, i + 1, k, env);
        out += '</a>';
        i = m + 1;
        continue;
      }
      out += '[';
      i++;
      continue;
    }
    // A plain run: everything up to the next character that can open a construct
    // (a backslash counts only before an escapable character, as in the reference).
    let end = hi;
    const scan = CONSTRUCT_SCAN;
    scan.lastIndex = i + 1;
    let mm;
    while ((mm = scan.exec(s)) !== null && mm.index < hi) {
      if (mm[0] !== '\\' || (mm.index + 1 < hi && isEscapable(s.charCodeAt(mm.index + 1)))) {
        end = mm.index;
        break;
      }
    }
    if (end > i) {
      const run = s.slice(i, end);
      out += ESC_PROBE.test(run) ? escapeHtmlRaw(run) : run;
    }
    i = end;
  }
  return out;
}

// --- line classification over ranges of the source (the reference's line readers, ranged) ---

/** A fence-opening line's language, or null. */
function fenceOpenRange(s, lo, hi) {
  if (s.charCodeAt(lo) !== 96 || s.charCodeAt(lo + 1) !== 96 || s.charCodeAt(lo + 2) !== 96) return null;
  let i = lo + 3;
  while (i < hi) {
    const cc = s.charCodeAt(i);
    if ((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || (cc >= 48 && cc <= 57) || cc === 95 || cc === 43 || cc === 45) i++;
    else break;
  }
  const langEnd = i;
  while (i < hi && (s[i] === ' ' || s[i] === '\t')) i++;
  return i === hi ? s.slice(lo + 3, langEnd) : null;
}

/** Whether the line range is a fence close. */
function isFenceCloseRange(s, lo, hi) {
  if (s.charCodeAt(lo) !== 96 || s.charCodeAt(lo + 1) !== 96 || s.charCodeAt(lo + 2) !== 96) return false;
  for (let i = lo + 3; i < hi; i++) {
    if (s[i] !== ' ' && s[i] !== '\t') return false;
  }
  return true;
}

/** A heading line's { depth, lo, hi } (its text range), or null. */
function headingRange(s, lo, hi) {
  let i = lo;
  while (i < hi && s[i] === '#') i++;
  const depth = i - lo;
  if (depth === 0 || depth > 6 || i >= hi) return null;
  const c = s[i];
  if (c !== ' ' && c !== '\t') return null;
  let j = i;
  while (j < hi && (s[j] === ' ' || s[j] === '\t')) j++;
  let end = hi;
  while (end > j && (s[end - 1] === ' ' || s[end - 1] === '\t')) end--;
  if (end === j) return null;
  return { depth, lo: j, hi: end };
}

/** Whether the line range is a thematic break. */
function isHrRange(s, lo, hi) {
  let i;
  if (s.startsWith('---', lo) || s.startsWith('***', lo)) i = lo + 3;
  else return false;
  for (; i < hi; i++) {
    if (s[i] !== ' ' && s[i] !== '\t') return false;
  }
  return true;
}

/** A bullet item's text start, or -1. */
function bulletStart(s, lo, hi) {
  const c = s[lo];
  return (c === '-' || c === '*') && s[lo + 1] === ' ' ? lo + 2 : -1;
}

/** An ordered item's { num, start }, or null. */
function orderedStart(s, lo, hi) {
  let i = lo;
  while (i < hi && s[i] >= '0' && s[i] <= '9') i++;
  const digits = i - lo;
  if (digits === 0 || digits > 9) return null;
  if (s[i] !== '.' || s[i + 1] !== ' ') return null;
  return { num: Number(s.slice(lo, i)), start: i + 2 };
}

/** Whether the line range continues a list item. */
function isContinuedRange(s, lo, hi) {
  let i = lo;
  while (i < hi && s[i] === ' ') i++;
  return i - lo >= 2 && i < hi && !isSpaceCode(s.charCodeAt(i));
}

/** The line range trimmed of spaces and tabs at either end, as [lo, hi]. */
function trimRange(s, lo, hi, out) {
  let a = lo;
  let b = hi;
  while (a < b && (s[a] === ' ' || s[a] === '\t')) a++;
  while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b--;
  out[0] = a;
  out[1] = b;
}

/** Whether the line range ends a paragraph: blank, a fence, a heading or a thematic break.
 * Dispatched on the first character, as in renderMarkdown: only a line opening on `, # or
 * - / * can be one of those blocks, and a line not led by a space or tab is never blank. */
function endsParagraphRange(s, lo, hi) {
  if (lo === hi) return true;
  const c = s.charCodeAt(lo);
  if (c === 32 || c === 9) return isBlankRange(s, lo, hi);
  if (c === 96) return fenceOpenRange(s, lo, hi) !== null;
  if (c === 35) return headingRange(s, lo, hi) !== null;
  if (c === 45 || c === 42) return isHrRange(s, lo, hi);
  return false;
}

/**
 * `src` rendered in one pass over its line ranges: its HTML (each block on its own lines, a "\n"
 * after the last), its table of contents (every level 2 and 3 heading: level, id and its inline
 * HTML), its excerpt (the first paragraph's inline HTML, or "") and its word count.
 */
function renderMarkdown(src, env) {
  const ids = new Set();
  const chunks = [];
  const toc = [];
  let excerpt = null;
  // The word count is taken in one pass over the whole body: "\n" is whitespace, so the
  // whole text's count is the sum of its lines' counts (the walk below visits the same text).
  const words = wordsInRange(src, 0, src.length);
  const n = src.length;
  // The current line is src[pos, lineEnd); the walk visits exactly the lines split('\n') yields
  // (a trailing "\n" leaves one last empty line, and there is always at least one line).
  let pos = 0;
  let lineEnd = 0;
  let nextPos = 0;
  let moreLines = false;
  let hasLine = true;
  const prime = () => {
    const nl = src.indexOf('\n', pos);
    lineEnd = nl === -1 ? n : nl;
    nextPos = nl === -1 ? n : nl + 1;
    moreLines = nl !== -1;
  };
  prime();
  const advance = () => {
    if (!moreLines) { hasLine = false; return; }
    pos = nextPos;
    prime();
  };
  const tr = [0, 0];
  // Block dispatch on the line's first character: a line opening on a letter (or any character
  // no block starts with) can only be a paragraph, a line led by a space or tab can only be
  // blank or a paragraph, and each block opener has its own first character — so the per-line
  // classifier calls of a naive cascade collapse into the one check that can match. The order
  // of outcomes is exactly the reference's (blank, fence, heading, break, quote, list, text).
  while (hasLine) {
    const c0 = pos < lineEnd ? src.charCodeAt(pos) : -1;
    if (c0 === -1 || ((c0 === 32 || c0 === 9) && isBlankRange(src, pos, lineEnd))) {
      advance();
      continue;
    }
    const lang = c0 === 96 ? fenceOpenRange(src, pos, lineEnd) : null;
    if (lang !== null) {
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      chunks.push(`<pre><code${cls}>`);
      advance();
      // The whole block is escaped in one pass: escaping is per-character, so escaping the
      // joined lines (each followed by "\n", as the reference emits them) is the same string.
      // The joined text runs to the last content line's end, plus its "\n" when the source has
      // one there; a final line without a "\n" (or the empty line a trailing "\n" leaves, which
      // the walk also visits) still contributes its own "\n".
      const contentStart = pos;
      let codeLines = 0;
      let lastEnd = pos;
      while (hasLine && !(src.charCodeAt(pos) === 96 && isFenceCloseRange(src, pos, lineEnd))) {
        codeLines++;
        lastEnd = lineEnd;
        advance();
      }
      if (codeLines > 0) {
        const hasNl = lastEnd < n && src.charCodeAt(lastEnd) === 10;
        chunks.push(escapeHtml(src.slice(contentStart, hasNl ? lastEnd + 1 : lastEnd)));
        if (!hasNl) chunks.push('\n');
      }
      if (hasLine) advance();
      chunks.push('</code></pre>\n');
      continue;
    }
    const heading = c0 === 35 ? headingRange(src, pos, lineEnd) : null;
    if (heading !== null) {
      const text = src.slice(heading.lo, heading.hi);
      const id = uniqueSlug(slugify(text), ids);
      const frag = inlineRange(text, 0, text.length, env);
      chunks.push(`<h${heading.depth} id="${id}">${frag}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html: frag });
      advance();
      continue;
    }
    if ((c0 === 45 || c0 === 42) && isHrRange(src, pos, lineEnd)) {
      chunks.push('<hr>\n');
      advance();
      continue;
    }
    if (c0 === 62) {
      const kept = [];
      while (hasLine && src.charCodeAt(pos) === 62) {
        let lo = pos + 1;
        if (src.charCodeAt(lo) === 32) lo++;
        trimRange(src, lo, lineEnd, tr);
        if (tr[1] > tr[0]) kept.push(src.slice(tr[0], tr[1]));
        advance();
      }
      if (kept.length === 0) chunks.push('<blockquote>\n</blockquote>\n');
      else {
        const joined = kept.join('\n');
        chunks.push(`<blockquote>\n<p>${inlineRange(joined, 0, joined.length, env)}</p>\n</blockquote>\n`);
      }
      continue;
    }
    const bStart = c0 === 45 || c0 === 42 ? bulletStart(src, pos, lineEnd) : -1;
    const oStart = bStart === -1 && c0 >= 48 && c0 <= 57 ? orderedStart(src, pos, lineEnd) : null;
    if (bStart !== -1 || oStart !== null) {
      const isOrdered = oStart !== null;
      const start = isOrdered ? oStart.num : 1;
      const items = [];
      let parts = null;
      while (hasLine) {
        const bs = isOrdered ? -1 : bulletStart(src, pos, lineEnd);
        const os = isOrdered ? orderedStart(src, pos, lineEnd) : null;
        if (bs !== -1 || os !== null) {
          if (parts !== null) items.push(parts.join('\n'));
          trimRange(src, isOrdered ? os.start : bs, lineEnd, tr);
          parts = [src.slice(tr[0], tr[1])];
          advance();
        } else if (isContinuedRange(src, pos, lineEnd)) {
          trimRange(src, pos, lineEnd, tr);
          parts.push(src.slice(tr[0], tr[1]));
          advance();
        } else break;
      }
      if (parts !== null) items.push(parts.join('\n'));
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      chunks.push(`${open}\n`);
      for (const item of items) {
        chunks.push(`<li>${inlineRange(item, 0, item.length, env)}</li>\n`);
      }
      chunks.push(`</${tag}>\n`);
      continue;
    }
    // The paragraph's text is its lines, trimmed and joined by '\n'. When no line
    // actually needs trimming, that text is exactly the contiguous source range
    // [paraStart, paraEnd) — the common case — and the parts array and join vanish.
    let paraParts = null;
    let paraStart = pos;
    let paraEnd = lineEnd;
    trimRange(src, pos, lineEnd, tr);
    if (tr[0] !== pos || tr[1] !== lineEnd) paraParts = [src.slice(tr[0], tr[1])];
    advance();
    while (hasLine && !endsParagraphRange(src, pos, lineEnd)) {
      trimRange(src, pos, lineEnd, tr);
      if (paraParts === null) {
        if (tr[0] !== pos || tr[1] !== lineEnd) {
          paraParts = [src.slice(paraStart, paraEnd), src.slice(tr[0], tr[1])];
        } else {
          paraEnd = lineEnd;
        }
      } else {
        paraParts.push(src.slice(tr[0], tr[1]));
      }
      advance();
    }
    let frag;
    if (paraParts === null) {
      frag = inlineRange(src, paraStart, paraEnd, env);
    } else {
      const text = paraParts.join('\n');
      frag = inlineRange(text, 0, text.length, env);
    }
    if (excerpt === null) excerpt = frag;
    chunks.push(`<p>${frag}</p>\n`);
  }
  return { html: chunks.join(''), toc, excerpt: excerpt ?? '', words };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }). `ctx` holds the parsed templates (`templates`, a Map of name to
 * nodes, a template that did not parse absent), the HTML escape and the include depth.
 */
function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var':
        out += ctx.escape(textOf(lookup(scope, n.path)));
        break;
      case 'raw':
        out += textOf(lookup(scope, n.path));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          out += renderNodes(n.body, { vars, parent: scope }, ctx, depth);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, scope, ctx, depth + 1);
        break;
      }
    }
  }
  return out;
}

// --- compiled templates ---

/** A path's head resolved in the scope chain (the generated code's entry-scope lookup). */
function lookupHead(scope, key) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, key)) s = s.parent;
  return s === null ? undefined : s.vars[key];
}

/** One own-property step of a path (the generated code's segment walk). */
function walkSeg(v, key) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, key) ? v[key] : undefined;
}

/** A value as escaped text (the generated code's {{ }} emission). */
function escTextOf(v) {
  return typeof v === 'string' ? escapeHtml(v) : escapeHtml(textOf(v));
}

/** An include from compiled code: the named template rendered in `scope`, or "" where it did not parse. */
function includeCompiled(ctx, name, scope, depth) {
  // Fragment cache: a template that reads only case-constant heads (site / tags / recent) and
  // holds no include renders the same string every time those heads bind the case's canonical
  // values, so it is rendered once per case. The binding check keeps a caller's loop variable
  // that shadows one of those names from ever seeing the cached string.
  const fc = ctx.frag;
  if (fc !== undefined) {
    const meta = fc.get(name);
    if (meta !== undefined) {
      let ok = true;
      for (let i = 0; i < meta.heads.length; i++) {
        if (lookupHead(scope, meta.heads[i]) !== meta.values[i]) { ok = false; break; }
      }
      if (ok) {
        if (meta.out === null) meta.out = renderIncluded(ctx, name, scope, depth);
        return meta.out;
      }
    }
  }
  return renderIncluded(ctx, name, scope, depth);
}

/** The named template rendered in `scope` (compiled if it compiled, else interpreted). */
function renderIncluded(ctx, name, scope, depth) {
  const f = ctx.compiled.get(name);
  if (f !== undefined) return f(scope, ctx, depth);
  const nodes = ctx.templates.get(name);
  return nodes === undefined ? '' : renderNodes(nodes, scope, ctx, depth);
}

/**
 * A template's free path heads (heads no enclosing for of its own binds), or null when its tree
 * holds an include. A template whose free heads are all case constants (site, tags, recent) and
 * which holds no include is a fragment candidate: its output cannot depend on the depth or on
 * anything else in the scope.
 */
function freeHeadsOf(nodes) {
  const free = new Set();
  const walk = (nodes, bound) => {
    for (const n of nodes) {
      if (n.kind === 'include') return false;
      if (n.kind === 'var' || n.kind === 'raw') {
        if (!bound.has(n.path[0])) free.add(n.path[0]);
      } else if (n.kind === 'if') {
        if (!bound.has(n.path[0])) free.add(n.path[0]);
        if (!walk(n.then, bound)) return false;
        if (n.else !== null && !walk(n.else, bound)) return false;
      } else if (n.kind === 'for') {
        if (!bound.has(n.path[0])) free.add(n.path[0]);
        const b2 = new Set(bound);
        b2.add(n.name);
        b2.add('loop');
        if (!walk(n.body, b2)) return false;
      }
    }
    return true;
  };
  return walk(nodes, new Set()) ? free : null;
}

/** The expanded tree's size cap: past it a template compiles unexpanded (includes stay calls). */
const EXPAND_CAP = 600;

/**
 * `nodes` with includes inlined: an include at inline-offset `o` (how many inlined includes
 * enclose it) becomes a guard node holding the target's nodes expanded at o+1, because at run
 * time it renders exactly when depth + o < 8 (depth is never negative); at o >= 8 it can never
 * render and is dropped, and a missing target renders nothing and is dropped too. Returns null
 * when the expansion grows past EXPAND_CAP (the caller then compiles the raw nodes).
 */
function expandNodes(nodes, templates, offset, state, noInline) {
  const out = [];
  for (const n of nodes) {
    if (++state.count > EXPAND_CAP) return null;
    switch (n.kind) {
      case 'text':
      case 'var':
      case 'raw':
        out.push(n);
        break;
      case 'if': {
        const then = expandNodes(n.then, templates, offset, state, noInline);
        if (then === null) return null;
        let els = null;
        if (n.else !== null) {
          els = expandNodes(n.else, templates, offset, state, noInline);
          if (els === null) return null;
        }
        out.push({ kind: 'if', not: n.not, path: n.path, then, else: els });
        break;
      }
      case 'for': {
        const body = expandNodes(n.body, templates, offset, state, noInline);
        if (body === null) return null;
        out.push({ kind: 'for', name: n.name, path: n.path, body });
        break;
      }
      case 'include': {
        if (offset >= INCLUDE_DEPTH) break;
        const target = templates.get(n.name);
        if (target === undefined) break;
        // Fragment candidates stay calls so the per-case fragment cache can engage.
        if (noInline.has(n.name)) { out.push(n); break; }
        const inner = expandNodes(target, templates, offset + 1, state, noInline);
        if (inner === null) return null;
        out.push({ kind: 'guard', k: INCLUDE_DEPTH - offset, body: inner });
        break;
      }
      default:
        out.push(n);
    }
  }
  return out;
}

/** Whether `nodes` (an expanded tree) hold a node of `kind`, looking everywhere. */
function treeHas(nodes, kind) {
  for (const n of nodes) {
    if (n.kind === kind) return true;
    if (n.kind === 'for' && treeHas(n.body, kind)) return true;
    if (n.kind === 'guard' && treeHas(n.body, kind)) return true;
    if (n.kind === 'if' && (treeHas(n.then, kind) || (n.else !== null && treeHas(n.else, kind)))) return true;
  }
  return false;
}

/**
 * Whether a for's body references the head `loop` where it means THIS for's loop object: paths
 * in the body itself, in nested ifs/guards, and in nested fors' source paths (those evaluate in
 * this scope) — but not inside a nested for's body, where `loop` is the nested one.
 */
function refsOwnLoop(nodes) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'var':
      case 'raw':
        if (n.path[0] === 'loop') return true;
        break;
      case 'if':
        if (n.path[0] === 'loop') return true;
        if (refsOwnLoop(n.then)) return true;
        if (n.else !== null && refsOwnLoop(n.else)) return true;
        break;
      case 'guard':
        if (refsOwnLoop(n.body)) return true;
        break;
      case 'for':
        if (n.path[0] === 'loop') return true;
        break;
      case 'include':
        break;
    }
  }
  return false;
}

/**
 * A template's nodes compiled to a straight-line render function. Includes are inlined first
 * (see expandNodes). In the generated code a path's head resolves to a generated local when an
 * enclosing for binds it (the loop variable, or `loop` for the loop object — a for variable
 * named `loop` is shadowed by its loop object, exactly as the interpreter's vars object does),
 * and otherwise to the entry scope: a for scope's vars hold only its variable and `loop`, so
 * every other head resolves in the entry scope's chain just as the interpreter finds it there.
 * A child scope object is materialized only for a for whose subtree still holds an include,
 * which is the only construct that receives the chain.
 */
function compileTemplate(nodes, templates, noInline) {
  const state = { count: 0 };
  const expanded = expandNodes(nodes, templates, 0, state, noInline);
  const root = expanded === null ? nodes : expanded;
  let uid = 0;
  const lines = [];
  // frames: stack of Maps from a path head to the generated local holding it.
  // scopeExpr: the generated expression for the current materialized scope chain node.
  const emit = (nodes, frames, scopeExpr) => {
    // A path's segments past its head, as one expression. For up to two segments the walk is
    // inlined as guarded ternaries (the same test walkSeg makes: a non-null object holding
    // the key as its own), which removes a helper call per segment from the hot render loop;
    // deeper paths keep the W chain (the ternary form duplicates its subexpression per level).
    const walk = (headExpr, path, from) => {
      let expr = headExpr;
      for (let k = from; k < path.length; k++) expr = `W(${expr},${JSON.stringify(path[k])})`;
      return expr;
    };
    const resolve = (path) => {
      for (let f = frames.length - 1; f >= 0; f--) {
        const hit = frames[f].get(path[0]);
        if (hit !== undefined) return walk(hit, path, 1);
      }
      return walk(`H(scope,${JSON.stringify(path[0])})`, path, 1);
    };
    for (const n of nodes) {
      switch (n.kind) {
        case 'text':
          if (n.text !== '') lines.push(`o+=${JSON.stringify(n.text)};`);
          break;
        case 'var':
          lines.push(`o+=V(${resolve(n.path)});`);
          break;
        case 'raw':
          lines.push(`o+=T(${resolve(n.path)});`);
          break;
        case 'if': {
          const cond = `Y(${resolve(n.path)})!==${n.not}`;
          if (n.else !== null) {
            lines.push(`if(${cond}){`);
            emit(n.then, frames, scopeExpr);
            lines.push('}else{');
            emit(n.else, frames, scopeExpr);
            lines.push('}');
          } else {
            lines.push(`if(${cond}){`);
            emit(n.then, frames, scopeExpr);
            lines.push('}');
          }
          break;
        }
        case 'guard':
          lines.push(`if(depth<${n.k}){`);
          emit(n.body, frames, scopeExpr);
          lines.push('}');
          break;
        case 'for': {
          const id = uid++;
          const xs = `x${id}`;
          const j = `j${id}`;
          const len = `n${id}`;
          const item = `v${id}`;
          const lp = `l${id}`;
          const child = `s${id}`;
          const materialize = treeHas(n.body, 'include');
          const needLoop = materialize || refsOwnLoop(n.body);
          const frame = new Map();
          if (n.name !== 'loop') frame.set(n.name, item);
          if (needLoop) frame.set('loop', lp);
          lines.push(`{const ${xs}=${resolve(n.path)};if(Array.isArray(${xs})){const ${len}=${xs}.length;for(let ${j}=0;${j}<${len};${j}++){const ${item}=${xs}[${j}];`);
          if (needLoop) lines.push(`const ${lp}={index:${j}+1,first:${j}===0,last:${j}===${len}-1,length:${len}};`);
          let innerScope = scopeExpr;
          if (materialize) {
            lines.push(`const ${child}={vars:{[${JSON.stringify(n.name)}]:${item},loop:${lp}},parent:${scopeExpr}};`);
            innerScope = child;
          }
          frames.push(frame);
          emit(n.body, frames, innerScope);
          frames.pop();
          lines.push('}}}');
          break;
        }
        case 'include':
          lines.push(`if(depth<${INCLUDE_DEPTH})o+=I(ctx,${JSON.stringify(n.name)},${scopeExpr},depth+1);`);
          break;
        default:
          throw new Error(`codegen: unknown node kind ${n.kind}`);
      }
    }
  };
  emit(root, [], 'scope');
  const maker = new Function('H', 'W', 'T', 'Y', 'V', 'I', `return function(scope,ctx,depth){let o='';${lines.join('')}return o;};`);
  return maker(lookupHead, walkSeg, textOf, truthy, escTextOf, includeCompiled);
}

// ---------------------------------------------------------------- the build

export const REPORT_FILE = 'build-report.txt';
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `rel` resolved from the directory parts of a source, or null when it climbs out of the root. */
function resolvePath(dirParts, rel) {
  const parts = dirParts.slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static. */
function readSources(b) {
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      b.sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    } else b.statics.push({ path: f.path, content: f.content });
  }
}

/** 2. Each source's front matter: a refused source is reported and dropped, and so is a draft. */
function frontMatter(b) {
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;
}

/** 3. Each page's output directory and url: its slug made unique in its directory, in source order. */
function permalinks(b) {
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }
}

/** Whether `target` opens on a scheme (the reference's scheme test, read by hand). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const cc = target.charCodeAt(i);
    if (cc === 58) return true;
    if (!((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || (cc >= 48 && cc <= 57) || cc === 43 || cc === 46 || cc === 45)) return false;
  }
  return false;
}

/** `rel` resolved from directory `dir` ("" or "a/b"), or null when it climbs out of the root:
 * resolvePath over the directory's parts, with a string fast path for the common shape — a
 * relative path holding no dot segment and no empty segment simply appends to the directory.
 * A segment is a dot segment only when it is exactly "." or "..", so the fast path is taken
 * unless one of those appears as a whole segment (or an empty segment from "//" appears). */
function resolveFrom(dir, dirParts, rel) {
  if (
    !rel.includes('//') && !rel.endsWith('/') &&
    rel !== '.' && rel !== '..' &&
    !rel.startsWith('./') && !rel.startsWith('../') &&
    !rel.endsWith('/.') && !rel.endsWith('/..') &&
    !rel.includes('/./') && !rel.includes('/../')
  ) {
    return dir === '' ? rel : `${dir}/${rel}`;
  }
  return resolvePath(dirParts, rel);
}

/** 4. Each body's Markdown, its links resolved to the pages and static files they name. */
function markdown(b) {
  const staticPaths = new Set(b.statics.map((f) => f.path));
  // Resolutions repeat across sources in the same directory (every post links the same
  // targets): resolutions are cached for the whole build, in a per-directory map keyed by
  // the fragment-free target; broken resolutions are cached as null and the per-source
  // report line is re-added on each occurrence.
  const linkCaches = new Map();
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    let linkCache = linkCaches.get(dir);
    if (linkCache === undefined) {
      linkCache = new Map();
      linkCaches.set(dir, linkCache);
    }
    const env = {
      link: (target) => {
        // Identity targets resolve to themselves without any map traffic.
        if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
        // The cache key is the fragment-free target, and broken resolutions are
        // cached too (stored as null): the report line names this source page, so
        // it is re-added per occurrence — the report is a set, and the line for a
        // repeated source/target pair is identical, so the set absorbs duplicates.
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        let base = linkCache.get(rel);
        if (base === undefined) {
          base = null;
          const path = rel === '' ? null : resolveFrom(dir, dirParts, rel);
          if (path !== null) {
            const dest = b.bySource.get(path);
            if (dest !== undefined) base = dest.url;
            else if (staticPaths.has(path)) base = `${b.base}/${path}`;
          }
          linkCache.set(rel, base);
        }
        if (base === null) {
          b.broken.add(`broken-link ${s.path} -> ${target}`);
          return target;
        }
        return base + frag;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }
}

/** 5. The posts, newest first and then by slug; each post's newer and older neighbours. */
function collections(b) {
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
}

/** 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug. */
function tags(b) {
  const bySlug = new Map();
  /** A source's tags, each slug once, in its own order. */
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (const s of b.sources) if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
}

/** A page's link record as templates read it (built once per source per build). */
function linkOf(b, s) {
  if (s === null) return null;
  let link = b.links.get(s);
  if (link === undefined) {
    link = { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
    b.links.set(s, link);
  }
  return link;
}

/** A tag as templates read it (its posts as cards). */
const tagOf = (b, t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });

/** A post's card, as lists show it (built once per source per build). */
function cardOf(b, s) {
  let card = b.cardCache.get(s);
  if (card === undefined) {
    card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil((s.words ?? wordsOf(s.body)) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    b.cardCache.set(s, card);
  }
  return card;
}

/** A page as its layout reads it (the card's fields, then its own). */
function pageOf(b, s) {
  const c = cardOf(b, s);
  return {
    title: c.title,
    url: c.url,
    date: c.date,
    date_long: c.date_long,
    summary: c.summary,
    excerpt: c.excerpt,
    reading_minutes: c.reading_minutes,
    tags: c.tags,
    slug: s.slug,
    content: s.html,
    // The toc entries already hold exactly { level, id, html } and templates only read them:
    // share the array instead of copying it for every page.
    toc: s.toc,
    newer: linkOf(b, s.newer ?? null),
    older: linkOf(b, s.older ?? null),
    is_post: s.post,
  };
}

/** 7. Every page through its layout, the index pages and the tag pages through theirs. */
function layouts(b) {
  b.cards = new Map(b.posts.map((p) => [p, cardOf(b, p)]));
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const canonical = { site, tags: allTags, recent };
  const frag = new Map();
  for (const [name, heads] of b.fragHeads) {
    frag.set(name, { heads, values: heads.map((h) => canonical[h]), out: null });
  }
  const ctx = { templates: b.templates, compiled: b.compiled, escape: escapeHtml, frag };
  const render = (name, vars) => {
    const scope = { vars: { site, tags: allTags, recent, ...vars }, parent: null };
    const fn = b.compiled.get(name);
    if (fn !== undefined) return fn(scope, ctx, 0);
    const nodes = b.templates.get(name);
    return nodes === undefined ? null : renderNodes(nodes, scope, ctx, 0);
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(b, s) });
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: tagOf(b, t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }
}

/** 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts. */
function report(b) {
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pages = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
}

/** One site's output tree: path -> text. */
export function build(input) {
  slugCache = new Map();
  dateCache = new Map();
  escCache = new Map();
  const templates = new Map();
  const reportLines = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      reportLines.push(err.message);
    }
  }
  // Fragment candidates: templates whose free heads are all case constants (site, tags, recent)
  // and which hold no include. They are never inlined, so the per-case fragment cache in
  // includeCompiled can engage at their include sites.
  const fragHeads = new Map();
  for (const [name, nodes] of templates) {
    const free = freeHeadsOf(nodes);
    if (free !== null) {
      let ok = true;
      for (const h of free) if (h !== 'site' && h !== 'tags' && h !== 'recent') { ok = false; break; }
      if (ok) fragHeads.set(name, [...free]);
    }
  }
  const compiled = new Map();
  for (const [name, nodes] of templates) {
    try {
      compiled.set(name, compileTemplate(nodes, templates, fragHeads));
    } catch {
      // Codegen refused this template's shape: the interpreter renders it instead.
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    compiled,
    fragHeads,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report: reportLines,
    posts: [],
    tags: [],
    cards: new Map(),
    cardCache: new Map(),
    links: new Map(),
    output: {},
  };
  readSources(b);
  frontMatter(b);
  permalinks(b);
  markdown(b);
  collections(b);
  tags(b);
  layouts(b);
  report(b);
  return b.output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
