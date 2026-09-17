// md-lite — a deliberately small markdown → DOM renderer for model answers (compare.html, AC22).
//
// 🔴 THE INVARIANT: model text NEVER reaches an HTML parser. Every node here is built with
// createElement/createTextNode, and every piece of the input ends up as a text node's data — never
// as markup. So `<img src=x onerror=alert(1)>` in an answer renders as those literal characters,
// and `[x](javascript:alert(1))` renders as text because only http(s) targets become anchors.
// test/compare-xss-guard.mjs runs this file against those fixtures AND greps this file and
// compare.js for innerHTML/outerHTML/insertAdjacentHTML/eval, so the invariant is checked from
// both ends (behaviour and source).
//
// Supported, on purpose only this much: paragraphs, headings (#..######), fenced code blocks,
// inline code, unordered/ordered lists (nested by indent, `1.`/`1)`), pipe tables, blockquotes,
// horizontal rules, **bold**, *italic*, ~~strike~~, [links](https://…), bare https?:// URLs and
// hard line breaks inside a paragraph. Images, raw HTML and footnotes are rendered as their
// literal text. That is a feature: the answer is being compared, not published, and every
// construct added here is more surface for the sanitizer argument to go wrong.
//
// The table / nested-list / strike / cite rules are ported from dowoo's sidepanel.js renderMarkdown
// (parseListItem, buildListHtml, the table branch, step 0) — the RULES only. dowoo builds HTML
// strings and sanitizes; here the same grammar drives createElement/appendInline.
//
// STREAMING: compare.js re-runs this on the whole accumulated text once per animation frame, so
// the last line is routinely half-typed (`| a | b` without its closing pipe, an unclosed fence, a
// `<cite index="38-` without its `>`). Nothing here throws on a prefix, and the structure of the
// lines BEFORE the last one must not depend on how much of the last line has arrived (a header row
// that flips table → paragraph → table while its separator is typed is a defect — Codex 1R #4).
// The half-typed last line itself renders as paragraph text (a half fence: as code; a half cite
// tag: dropped) and upgrades once it completes.
//
// `doc` is injectable so the guard can run this in Node against test/lib/mini-dom.mjs.

const FENCE_RE = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/;
// 🔴 Greedy body, trailing-hash trim done by hand. The first version was `^(#{1,6})\s+(.*?)\s*#*\s*$`
// and a heading whose body is 4,000 spaces took ~9s: three adjacent variable-width groups over the
// same run of whitespace backtrack against each other (Codex 2R). Every block regex here now has at
// most ONE variable-width whitespace run before a required token, and lines are right-trimmed first.
const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/;
// List items keep their leading whitespace (group 1): its width decides nesting (dowoo parseListItem).
const UL_RE = /^([ \t]*)[-*+][ \t]+(.*)$/;
const OL_RE = /^([ \t]*)\d+[.)][ \t]+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
// A table separator cell: `---`, `:---`, `---:`, `:---:` (GFM). Checked per cell, so a row of
// stray colons/pipes is NOT a separator — the block then renders as plain td rows.
const TABLE_SEP_CELL_RE = /^:?-+:?$/;
// A separator row still being streamed (`|`, `|--`, `|---|:-`): only ever tested on the LAST line
// of the input, where it promotes the row above it to a header so the header does not flip
// table → paragraph → table while the dashes arrive (Codex 1R #4).
const TABLE_SEP_PREFIX_RE = /^\|[ \t:|-]*$/;
// Claude-family citation tags `<cite index="38-2">…</cite>` (dowoo step 0): the tags go, the inner
// text stays. Attribute run capped at 200 chars and stopped by `<`, so a run of `<cite` openers
// without a `>` costs O(200) each, not O(rest of text). The tail form matches ONLY when applied to
// the slice from the LAST `<` (see preClean) — that is what makes it linear.
const CITE_TAG_RE = /<\/?cite\b[^<>\n]{0,200}>/gi;
const CITE_TAIL_RE = /^<\/?cite\b[^<>\n]{0,200}$/i;
// Inline tokens, leftmost-first: code span, <br>, bold, italic, strike, link, bare URL.
// 🔴 Every alternative is bounded by a negated class that stops at its own delimiter, so a scan
// from one position costs O(distance to the next delimiter), not O(rest of line). The first
// version used `(`+)([^`][\s\S]*?[^`])\1` for code spans and went quadratic on a run of
// backticks followed by text (Codex: 32k chars ≈ 2.2s on the UI thread). Code spans are now
// single-backtick only; a multi-backtick span stays literal text.
// Link label/URL are length-capped for the same reason: `[`×30k + `](` + `a`×30k made every `[`
// re-scan the whole URL run (896ms). And a line longer than MAX_INLINE_LINE skips inline parsing
// entirely (rendered as one text node) — no real prose line is that long, and it bounds the
// per-line cost at the cap.
// Bare URLs: lowercase `https?://` only (dowoo parity), stopped by whitespace/brackets/backtick so a
// URL followed by `)` or a code span keeps its punctuation outside the anchor. An explicit
// `[label](url)` or a code span starting earlier on the line wins because the match is leftmost.
// `<br>` / `<br/>` / `<br />` (any case) is the ONE tag rendered, as a real <br> element: GFM table
// cells cannot hold a newline, so Gemini/ChatGPT write `<br>` inside them (2026-09-18, live Gemini
// table) and it showed literally. Still no innerHTML — the token maps to createElement('br').
const INLINE_RE = /`([^`\n]+)`|<[bB][rR]\s*\/?>|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|(?<![\w*])\*([^*\n]+?)\*(?![\w*])|(?<![\w_])_([^_\n]+?)_(?![\w_])|~~([^~\n]+?)~~|(?<!!)\[([^\]\n]{1,500}?)\]\(([^)\s]{1,2000}?)(?:\s+"[^"]*")?\)|(?<![\w/])(https?:\/\/[^\s<>()[\]`]{1,2000})/;
// Trailing sentence punctuation is not part of a bare URL (`see https://x.y.` → the dot stays text).
const URL_TRAIL_CHARS = '.,;:!?\'"';
export const MAX_INLINE_LINE = 4000;
const SAFE_LINK_RE = /^https?:\/\//i;
// Resource limits. A model answer is bounded by the provider, but a hostile one is not: past
// MAX_CHARS the remainder is appended as one text node (still visible, never parsed), and past
// MAX_QUOTE_DEPTH a `>` line is rendered as its own text instead of recursing (a 10k-deep quote
// blew the stack before this — Codex). Lists nest at most MAX_LIST_DEPTH deep (deeper indents
// become siblings — same reason). A table takes at most MAX_TABLE_ROWS rows (the rest of the
// block is paragraph text) and a row keeps at most MAX_TABLE_COLS cells (the rest fold into the last).
export const MAX_CHARS = 200000;
export const MAX_QUOTE_DEPTH = 8;
export const MAX_LIST_DEPTH = 8;
export const MAX_TABLE_ROWS = 500;
export const MAX_TABLE_COLS = 32;

/** `Title ##` → `Title` (ATX closing hashes), linear-time — see HEADING_RE. */
function stripClosingHashes(text) {
  let end = text.length;
  while (end > 0 && text[end - 1] === '#') end--;
  if (end === text.length) return text;
  if (end === 0) return '';
  const c = text[end - 1];
  return (c === ' ' || c === '\t') ? text.slice(0, end).trimEnd() : text;
}

/** True when `url` may become an anchor href. Anything else stays literal text. */
export function isSafeLinkTarget(url) {
  return SAFE_LINK_RE.test(String(url || '').trim());
}

/**
 * Step 0 (dowoo): drop provider annotations that are not answer text. Only the Claude `<cite>`
 * rules live here — the ChatGPT ones (`【…】`, keyword+JSON fragments, `cite…turn0search1`,
 * `{"layout":"carousel"…}`, `,"query":[…],"num_per_query":N}`) are already applied by
 * vendor-ai/chatgpt-client.js `_stripAnnotations` on every chunk before the text reaches this
 * page, so repeating them here would be a second copy to keep in sync for no reader.
 */
export function preClean(text) {
  let out = text.replace(CITE_TAG_RE, '');
  // Mid-stream half tag: `…<cite index="38-` — only the slice from the LAST `<` is tested.
  const lt = out.lastIndexOf('<');
  if (lt >= 0 && CITE_TAIL_RE.test(out.slice(lt))) out = out.slice(0, lt);
  return out;
}

/** Leading-whitespace width; a tab counts as 4 so `\t- x` nests under `- x` like 4 spaces would. */
function indentWidth(ws) {
  let w = 0;
  for (let k = 0; k < ws.length; k++) w += ws[k] === '\t' ? 4 : 1;
  return w;
}

/** `{ indent, ordered, content }` for a list-item line, else null (dowoo parseListItem). */
function parseListItem(line) {
  let m = UL_RE.exec(line);
  if (m) return { indent: indentWidth(m[1]), ordered: false, content: m[2] };
  m = OL_RE.exec(line);
  if (m) return { indent: indentWidth(m[1]), ordered: true, content: m[2] };
  return null;
}

/**
 * Build one <ul>/<ol> from items[start…] (dowoo buildListHtml): the first item fixes the indent
 * and kind; a shallower item ends the list, a same-indent item of the other kind starts a sibling
 * list (caller loops), a deeper item nests under the previous <li>. Consumes ≥1 item per call, so
 * the whole list block is O(items). Past MAX_LIST_DEPTH a deeper item is rendered as a sibling.
 */
function buildList(items, start, d, depth) {
  const first = items[start];
  const list = d.createElement(first.ordered ? 'ol' : 'ul');
  let i = start;
  let lastLi = null;
  while (i < items.length) {
    const it = items[i];
    if (it.indent < first.indent) break;
    if (it.indent === first.indent && it.ordered !== first.ordered) break;
    if (it.indent === first.indent || depth >= MAX_LIST_DEPTH) {
      lastLi = d.createElement('li');
      appendInline(lastLi, it.content, d);
      list.appendChild(lastLi);
      i++;
      continue;
    }
    const nested = buildList(items, i, d, depth + 1);
    // A deeper run with no <li> at this level yet (dowoo: "deeper indent without parent") hangs
    // off the list itself rather than being dropped.
    (lastLi || list).appendChild(nested.node);
    i = nested.end;
  }
  return { node: list, end: i };
}

/** True when the `|` at `row[at]` is escaped: preceded by an ODD run of backslashes (`\|` yes, `\\|` no). */
function pipeEscapedAt(row, at) {
  let n = 0;
  for (let k = at - 1; k >= 0 && row[k] === '\\'; k--) n++;
  return n % 2 === 1;
}

/** `|…|` with an unescaped closing pipe — a COMPLETE row shape (it may still fail parseTableRow). */
function looksLikeRow(row) {
  return row.length >= 2 && row[0] === '|' && row[row.length - 1] === '|' && !pipeEscapedAt(row, row.length - 1);
}

/**
 * Cells of a table row, or null when `line` is not a row: it must start with `|`, end with an
 * UNESCAPED `|` (`| c \|` is a row still being typed — Codex 1R #5; `\\|` is an escaped backslash
 * then a real pipe — 2R #4) and have at least one cell. Cells past MAX_TABLE_COLS are folded into
 * the last cell as text (rejecting the row instead turned a line from "row" into "not a row" the
 * moment its closing pipe arrived — table → paragraph → table flicker, Codex 3R #2). `\|` inside a
 * cell is a literal pipe, not a boundary (dowoo splits on every `|`; a code-ish cell like
 * `a \| b` is common enough to handle), and so is a `|` inside a single-backtick code span that
 * CLOSES within the row (`| \`a|b\` |` — dowoo stashes code spans before splitting). A backtick
 * with no closer ahead is literal and protects nothing, so it cannot swallow the remaining cells.
 */
function parseTableRow(line) {
  const row = line.trim();
  if (!looksLikeRow(row)) return null;
  const cells = [];
  let cur = '';
  let noMoreTicks = false;
  for (let k = 1; k < row.length; k++) {
    const ch = row[k];
    if (ch === '`' && !noMoreTicks) {
      const close = row.indexOf('`', k + 1);
      // Once a backtick has no closer, none after it can have one either — one scan, not one per tick.
      if (close < 0) { noMoreTicks = true; } else { cur += row.slice(k, close + 1); k = close; continue; }
    }
    if (ch === '\\' && row[k + 1] === '|' && !pipeEscapedAt(row, k + 1)) { cur += '\\'; continue; }
    if (ch === '\\' && row[k + 1] === '|') { cur += '|'; k++; continue; }
    if (ch === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  // The trailing pipe is unescaped (looksLikeRow), so `cur` is empty here unless a code span ran
  // past it; keep that text rather than drop it.
  if (cur.trim()) cells.push(cur.trim());
  if (!cells.length) return null;
  if (cells.length > MAX_TABLE_COLS) cells.splice(MAX_TABLE_COLS - 1, cells.length, cells.slice(MAX_TABLE_COLS - 1).join(' | '));
  return cells;
}

/**
 * The streaming tail (Codex 1R #4 / 2R #2-#3): the LAST non-blank line of the input, when it is a
 * half-typed row — starts with `|`, is not a complete row shape, and has at least two characters.
 * A lone `|` is ambiguous (separator or data row?) and does not count, so the first promotion of
 * the row above is already the right kind (th vs td) and never flips. A complete-but-rejected row
 * Returns the trimmed line or null.
 *
 * 🔑 A tail that is a separator PREFIX (`| -`, `|:`) promotes the row above to a header; if it then
 * turns out to be data (`| -5 |` as row 2 of a separator-less table) the header flips th → td once
 * (Codex 3R #1). That is the accepted residual: an ambiguous prefix has to be resolved by policy,
 * and a `|`-line after a `|…|` line is a separator in practically every real answer (GFM tables
 * always have one), so the policy that never flips for those is the right one.
 */
function streamingTail(lines, j, lastIdx) {
  if (j !== lastIdx) return null;
  const t = lines[j].trim();
  if (t.length < 2 || t[0] !== '|' || looksLikeRow(t)) return null;
  return t;
}

function isSeparatorRow(cells) {
  return cells.every((c) => TABLE_SEP_CELL_RE.test(c));
}

/** `:---:` → center, `---:` → right, `:---` → left, `---` → null. */
function alignOf(sepCell) {
  const l = sepCell[0] === ':';
  const r = sepCell[sepCell.length - 1] === ':';
  return l && r ? 'center' : (r ? 'right' : (l ? 'left' : null));
}

/**
 * <div.md-table-wrap><table>…: thead+tbody when row 1 is a separator (or `headerOnly`: the
 * separator is still streaming and rows has just the header), tbody only otherwise.
 */
function buildTable(rows, d, headerOnly = false) {
  const wrap = d.createElement('div');
  wrap.className = 'md-table-wrap';
  const table = d.createElement('table');
  let body = rows;
  let aligns = [];
  const appendRow = (parent, cells, tag) => {
    const tr = d.createElement('tr');
    cells.forEach((c, idx) => {
      const cell = d.createElement(tag);
      // `aligns` holds only the three constant strings from alignOf — never model text.
      if (aligns[idx]) cell.setAttribute('data-align', aligns[idx]);
      appendInline(cell, c, d);
      tr.appendChild(cell);
    });
    parent.appendChild(tr);
  };
  if (headerOnly || (rows.length >= 2 && isSeparatorRow(rows[1]))) {
    if (!headerOnly) aligns = rows[1].map(alignOf);
    const thead = d.createElement('thead');
    appendRow(thead, rows[0], 'th');
    table.appendChild(thead);
    body = rows.slice(headerOnly ? 1 : 2);
  }
  const tbody = d.createElement('tbody');
  body.forEach((cells) => appendRow(tbody, cells, 'td'));
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

/** Render `text` (markdown) into a DocumentFragment of `doc`. Never throws on odd input. */
export function renderMarkdown(text, doc, depth = 0) {
  const d = doc || document;
  const frag = d.createDocumentFragment();
  let src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  if (depth === 0) src = preClean(src);
  let overflow = '';
  if (src.length > MAX_CHARS) { overflow = src.slice(MAX_CHARS); src = src.slice(0, MAX_CHARS); }
  const lines = src.split('\n');
  // Index of the last non-blank line — the line "in flight" while streaming (see streamingTail).
  let lastIdx = lines.length - 1;
  while (lastIdx > 0 && !lines[lastIdx].trim()) lastIdx--;
  let i = 0;
  let para = [];

  const flushPara = () => {
    if (!para.length) return;
    const p = d.createElement('p');
    para.forEach((line, idx) => {
      if (idx > 0) p.appendChild(d.createElement('br'));
      appendInline(p, line, d);
    });
    frag.appendChild(p);
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i].trimEnd();

    // Fenced code: everything up to the closing fence is ONE text node.
    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushPara();
      const pre = d.createElement('pre');
      const code = d.createElement('code');
      if (fence[2]) code.setAttribute('data-lang', fence[2]);
      const buf = [];
      i++;
      while (i < lines.length && !(FENCE_RE.test(lines[i]) && lines[i].trim().startsWith(fence[1]))) { buf.push(lines[i]); i++; }
      i++; // skip the closing fence (or run off the end of an unterminated block)
      code.textContent = buf.join('\n');
      pre.appendChild(code);
      frag.appendChild(pre);
      continue;
    }

    if (!line.trim()) { flushPara(); i++; continue; }

    if (HR_RE.test(line)) { flushPara(); frag.appendChild(d.createElement('hr')); i++; continue; }

    const h = HEADING_RE.exec(line);
    if (h) {
      flushPara();
      const el = d.createElement('h' + h[1].length);
      appendInline(el, stripClosingHashes(h[2]), d);
      frag.appendChild(el);
      i++;
      continue;
    }

    // Table: ≥2 consecutive `|…|` rows. A single `|…|` line is paragraph text. A half-typed row
    // (no closing pipe) is paragraph text too — but when it is the LAST line of the input it still
    // counts toward the two-row threshold, and a half separator there makes row 0 a header, so the
    // rows already on screen keep their structure while the next one streams in (Codex 1R #4).
    if (line.trim().startsWith('|')) {
      const rows = [];
      let j = i;
      while (j < lines.length && rows.length < MAX_TABLE_ROWS) {
        const cells = parseTableRow(lines[j]);
        if (!cells) break;
        rows.push(cells);
        j++;
      }
      const tail = streamingTail(lines, j, lastIdx);
      if (rows.length + (tail ? 1 : 0) >= 2) {
        flushPara();
        frag.appendChild(buildTable(rows, d, tail !== null && rows.length === 1 && TABLE_SEP_PREFIX_RE.test(tail)));
        i = j;
        // Rows past the cap stay visible as paragraph lines rather than opening a second table.
        while (i < lines.length && parseTableRow(lines[i])) { para.push(lines[i].trimEnd()); i++; }
        continue;
      }
    }

    // List block: consecutive items, a blank line between two items does not end the block
    // (dowoo — keeps numbering intact). Then one <ul>/<ol> per top-level run.
    if (parseListItem(line)) {
      flushPara();
      const items = [];
      while (i < lines.length) {
        const it = parseListItem(lines[i].trimEnd());
        if (it) { items.push(it); i++; continue; }
        if (!lines[i].trim() && i + 1 < lines.length && parseListItem(lines[i + 1].trimEnd())) { i++; continue; }
        break;
      }
      let j = 0;
      while (j < items.length) {
        const r = buildList(items, j, d, 0);
        frag.appendChild(r.node);
        j = r.end;
      }
      continue;
    }

    if (QUOTE_RE.test(line) && depth < MAX_QUOTE_DEPTH) {
      flushPara();
      const bq = d.createElement('blockquote');
      const inner = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) { inner.push(QUOTE_RE.exec(lines[i])[1]); i++; }
      bq.appendChild(renderMarkdown(inner.join('\n'), d, depth + 1));
      frag.appendChild(bq);
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();
  if (overflow) frag.appendChild(d.createTextNode(overflow));
  return frag;
}

/**
 * True when an emphasis/strike/link-label body would swallow half of a code span (odd number of
 * backticks: ``~~a `https://x~~` `` — Codex 1R #1). Such a match is rejected and the scan resumes
 * one character later, so the code span wins as it does in CommonMark.
 */
function splitsCodeSpan(body) {
  let ticks = 0;
  for (let k = 0; k < body.length; k++) if (body[k] === '`') ticks++;
  return ticks % 2 === 1;
}

/** Build an <a> for a vetted http(s) target; the caller has already checked isSafeLinkTarget. */
function makeAnchor(url, d) {
  const a = d.createElement('a');
  a.setAttribute('href', url.trim());
  a.setAttribute('rel', 'noopener noreferrer');
  a.setAttribute('target', '_blank');
  return a;
}

/**
 * Append `text` to `parent` as inline nodes (code/strong/em/del/a/text). `inLink` is set while
 * rendering a link label: a `[…](…)` or bare URL inside it stays text — anchors never nest.
 */
export function appendInline(parent, text, doc, inLink = false) {
  const d = doc || document;
  let rest = String(text);
  if (rest.length > MAX_INLINE_LINE) { parent.appendChild(d.createTextNode(rest)); return; }
  while (rest.length) {
    const m = INLINE_RE.exec(rest);
    if (!m) { parent.appendChild(d.createTextNode(rest)); return; }
    const body = m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? m[7];
    if (body !== undefined && splitsCodeSpan(body)) {
      parent.appendChild(d.createTextNode(rest.slice(0, m.index + 1)));
      rest = rest.slice(m.index + 1);
      continue;
    }
    if (m.index > 0) parent.appendChild(d.createTextNode(rest.slice(0, m.index)));
    let consumed = m[0].length;
    if (m[1] === undefined && /^<[bB][rR]/.test(m[0])) {
      parent.appendChild(d.createElement('br'));
    } else if (m[1] !== undefined) {
      const code = d.createElement('code');
      code.textContent = m[1].trim();
      parent.appendChild(code);
    } else if (m[2] !== undefined || m[3] !== undefined) {
      const strong = d.createElement('strong');
      appendInline(strong, m[2] !== undefined ? m[2] : m[3], d, inLink);
      parent.appendChild(strong);
    } else if (m[4] !== undefined || m[5] !== undefined) {
      const em = d.createElement('em');
      appendInline(em, m[4] !== undefined ? m[4] : m[5], d, inLink);
      parent.appendChild(em);
    } else if (m[6] !== undefined) {
      const del = d.createElement('del');
      appendInline(del, m[6], d, inLink);
      parent.appendChild(del);
    } else if (m[7] !== undefined) {
      const label = m[7];
      const url = m[8];
      if (!inLink && isSafeLinkTarget(url)) {
        const a = makeAnchor(url, d);
        appendInline(a, label, d, true);
        parent.appendChild(a);
      } else {
        // Unsafe scheme (javascript:, data:, relative, …): the whole construct stays literal text.
        parent.appendChild(d.createTextNode(m[0]));
      }
    } else if (m[9] !== undefined) {
      // Bare URL: the match IS the URL (the lookbehind is zero-width), minus trailing punctuation
      // which is handed back to the text that follows.
      let url = m[9];
      while (url.length && URL_TRAIL_CHARS.includes(url[url.length - 1])) url = url.slice(0, -1);
      consumed = url.length;
      if (!inLink && isSafeLinkTarget(url)) {
        const a = makeAnchor(url, d);
        a.appendChild(d.createTextNode(url));
        parent.appendChild(a);
      } else {
        parent.appendChild(d.createTextNode(url));
      }
    }
    rest = rest.slice(m.index + consumed);
  }
}
