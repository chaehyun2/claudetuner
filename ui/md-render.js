// md-render — markdown → DOM for model answers (compare.html). Replaces the hand-written
// ui/md-lite.js (#1551): after four grammar fixes in two weeks (table rows with raw newlines,
// `<br>` in cells, nested lists, streaming tails) the GRAMMAR is now markdown-it's — CommonMark +
// GFM tables/strikethrough, linear on hostile input (its emphasis/link/nesting rules are the spec's
// algorithms, with a nesting cap) — and only the DOM emission and the provider quirks stay here.
//
// 🔴 THE INVARIANT (unchanged from md-lite): model text NEVER reaches an HTML parser. markdown-it
// is used as a TOKENIZER only (`md.parse`, never `md.render`); every node is built with
// createElement/createTextNode from the token stream, and every piece of the input ends up as a
// text node's data — never as markup. `html: false` makes `<img src=x onerror=alert(1)>` a text
// token; `[x](javascript:alert(1))` is text because validateLink admits only http(s). Tags come
// from a fixed allowlist (markdown-it's own constant tag names), attributes from ATTRS below.
// test/compare-xss-guard.mjs runs this file against hostile fixtures in Node (test/lib/mini-dom.mjs
// throws on innerHTML) AND greps this file and compare.js for innerHTML/outerHTML/
// insertAdjacentHTML/eval, so the invariant is checked from both ends.
//
// Rendered: paragraphs, ATX/setext headings, fenced/indented code, inline code, ordered/unordered
// lists (nested), GFM tables (alignment → data-align), blockquotes, rules, **bold**, *italic*,
// ~~strike~~, [links](https://…), bare https?:// URLs (schemed only — no `foo.js` autolinks),
// hard line breaks (`breaks: true`, as md-lite did) and a typed `<br>` (the one tag, see below).
// Images render as `!` + a link to the image (the rule is disabled; no <img> is ever created).
// Raw HTML is literal text. Inline TeX (`$\rightarrow$`, `$10^{-3}$`) is rewritten to plain
// characters by an inline rule when every construct is a known symbol/wrapper/script (#1558).
//
// PROVIDER QUIRKS (normalizeTables) — kept from md-lite because live answers need them and GFM
// has no rule for them. They edit the TEXT, but are planned from markdown-it's own block map of a
// first parse (only lines it called a table row / the trailing paragraph are touched — never
// code) and the edited text is parsed again:
//   1. A table row whose cell holds RAW newlines (2026-09-20 Gemini/Claude itinerary table):
//      `| 9/24 | text` … `more text |` — the following lines are gathered (≤ MAX_TABLE_CELL_LINES)
//      until one ends with an unescaped pipe, joined with `<br>` and parsed as ONE row. Only body
//      rows of a table markdown-it recognised; gives up on another row start or no closer within
//      the bound.
//   2. STREAMING: compare.js re-runs this on the whole accumulated text once per animation frame,
//      so the last line is routinely half-typed. GFM needs the separator row's cell count to equal
//      the header's, so a header would render as a paragraph until its separator is complete, then
//      flip to a table. When the last non-blank line is a separator PREFIX (`|-`, `|---|:-`) under
//      a complete row, it is completed to a full separator of the header's width — the header is
//      a <th> row from its first frame and never flips (md-lite's tail rule, Codex 1R #4).
//   3. Claude-family `<cite index="38-2">…</cite>` tags go, their inner text stays (preClean).
// A typed `<br>` / `<BR/>` / `<br />` is rendered as a real <br> element: GFM cells cannot hold a
// newline, so Gemini/ChatGPT write `<br>` inside them (2026-09-18). The RAW tag is swapped for a
// private-use mark before tokenizing (markBreaks) and the emitter maps the mark to
// createElement('br') — still no innerHTML; `&lt;br&gt;`, `\<br>` and a `<br>` inside code stay
// the literal characters. Any other tag stays literal text.
//
// `doc` is injectable so the guards can run this in Node against test/lib/mini-dom.mjs.

import markdownit from '../vendor-md/markdown-it.esm.min.mjs';

const SAFE_LINK_RE = /^https?:\/\//i;
// A hostile answer is unbounded; past MAX_CHARS the remainder is appended as one text node (still
// visible, never parsed).
export const MAX_CHARS = 200000;
// Quirk 1's bound: a row start with no closer within this many lines is paragraph text.
export const MAX_TABLE_CELL_LINES = 20;
// A typed `<br>` is WRAPPED in a pair of private-use characters BEFORE tokenizing (markBreaks):
// `<BR />` → U+E000 `<BR />` U+E001. The emitter renders a wrapped tag in a text token as a <br>
// element and, everywhere else (code spans, fences, a URL), drops the two marks so the original
// spelling survives verbatim (Codex 2R #2). Only the RAW tag is wrapped: `&lt;br&gt;` and `\<br>`
// reach the emitter as the literal characters `<br>` with no marks — not a break (Codex 1R #4).
// Pre-existing marks in the answer are dropped first; an entity-forged pair (`&#57344;<br>&#57345;`)
// can at most produce the <br> its own text names.
const BR_OPEN = '\uE000';
const BR_CLOSE = '\uE001';
const BR_MARKS_RE = /[\uE000\uE001]/g;
// The wrapped tag as it appears in a text token (markdown-it leaves the marks and the tag alone).
const BR_WRAPPED_RE = /\uE000<br[ \t]*\/?>\uE001/gi;
// What the lines of a continued row are joined with before tokenizing: a wrapped break (a cell
// with a typed `<br>` looks identical).
const CELL_LINE_JOIN = BR_OPEN + '<br>' + BR_CLOSE;
// A GFM separator cell (`---`, `:--:`) — a row of these is the delimiter row, never a data row.
const SEP_CELL_RE = /^:?-+:?$/;
// A separator row still being streamed (`|-`, `|---|:-`): only ever tested on the LAST non-blank
// line. A lone `|` is ambiguous (separator or data row?) and does not count.
const TABLE_SEP_PREFIX_RE = /^\|[ \t:|-]+$/;
// Claude-family citation tags (dowoo step 0). Attribute run capped at 200 chars and stopped by `<`,
// so a run of `<cite` openers without a `>` costs O(200) each, not O(rest of text). The tail form
// matches ONLY the slice from the LAST `<` (see preClean) — that is what makes it linear.
const CITE_TAG_RE = /<\/?cite\b[^<>\n]{0,200}>/gi;
const CITE_TAIL_RE = /^<\/?cite\b[^<>\n]{0,200}$/i;
// A break tag in any spelling ON ONE LINE (`<br\n>` is not one: the newline must stay a line
// break for the block parser — Codex 3R #3); markBreaks checks the backslash run before it
// (`\<br>` is escaped text, `\\<br>` is an escaped backslash and a real tag — parity, Codex 2R #4).
const BR_TAG_RE = /<br[ \t]*\/?>/gi;
const LANG_RE = /^[\w+#.-]{1,40}$/;
const ALIGN_RE = /text-align:\s*(left|center|right)/;
// Every tag this file may create. markdown-it's token tags are constant strings from its rules,
// but the allowlist keeps a future rule (or a plugin) from adding an element type silently.
const TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr', 'br',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'strong', 'em', 's', 'a', 'div']);

/** True when `url` may become an anchor href. Anything else stays literal text. */
export function isSafeLinkTarget(url) {
  return SAFE_LINK_RE.test(String(url || '').trim());
}

const md = markdownit({ html: false, linkify: true, breaks: true, typographer: false });
md.disable('image');
// Schemed URLs only: `example.com` / `foo.js` / `a@b.c` in prose are not links (md-lite parity).
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });
// markdown-it's default rejects javascript:/vbscript:/file:/data: — this admits ONLY http(s), so
// `ftp:`, `mailto:` and protocol-relative `//x` targets stay text too (applies to linkify as well).
md.validateLink = isSafeLinkTarget;

/**
 * Quirk 3: drop provider annotations that are not answer text. Only the Claude `<cite>` rules
 * live here — the ChatGPT ones (`【…】`, keyword+JSON fragments, …) are already applied by
 * vendor-ai/chatgpt-client.js `_stripAnnotations` on every chunk before the text reaches this page.
 */
export function preClean(text) {
  let out = text.replace(CITE_TAG_RE, '');
  // Mid-stream half tag: `…<cite index="38-` — only the slice from the LAST `<` is tested.
  const lt = out.lastIndexOf('<');
  if (lt >= 0 && CITE_TAIL_RE.test(out.slice(lt))) out = out.slice(0, lt);
  return out;
}

/** True when the `|` at `row[at]` is escaped: preceded by an ODD run of backslashes (`\|` yes, `\\|` no). */
function pipeEscapedAt(row, at) {
  let n = 0;
  for (let k = at - 1; k >= 0 && row[k] === '\\'; k--) n++;
  return n % 2 === 1;
}

/** `|…|` with an unescaped closing pipe — a complete row shape. */
function looksLikeRow(t) {
  return t.length >= 2 && t[0] === '|' && t[t.length - 1] === '|' && !pipeEscapedAt(t, t.length - 1);
}

/** Cell count of a complete row, GFM style: split on unescaped `|`, outer pipes dropped. */
function rowWidth(t) {
  let n = 0;
  for (let k = 1; k < t.length - 1; k++) if (t[k] === '|' && !pipeEscapedAt(t, k)) n++;
  return n + 1;
}

/** True when `t` (trimmed, starts with `|`) is a GFM delimiter row, closing pipe or not: `|---|:--:`. */
function isSeparatorRow(t) {
  const body = t.slice(1, t[t.length - 1] === '|' ? -1 : undefined);
  const cells = body.split('|').map((c) => c.trim());
  return cells.length > 0 && cells.every((c) => SEP_CELL_RE.test(c));
}

/** Wrap every raw, unescaped `<br>` tag in BR_OPEN/BR_CLOSE (see the constants). */
export function markBreaks(src) {
  const clean = src.replace(BR_MARKS_RE, '');
  let out = '';
  let last = 0;
  BR_TAG_RE.lastIndex = 0;
  let m;
  while ((m = BR_TAG_RE.exec(clean)) !== null) {
    let slashes = 0;
    for (let k = m.index - 1; k >= 0 && clean[k] === '\\'; k--) slashes++;
    if (slashes % 2 === 1) continue; // `\<` is an escaped `<`: the tag is text
    out += clean.slice(last, m.index) + BR_OPEN + m[0] + BR_CLOSE;
    last = m.index + m[0].length;
  }
  return last ? out + clean.slice(last) : clean;
}

/**
 * Quirks 1 and 2 (see the header), planned from markdown-it's OWN block structure: `tokens` is the
 * parse of `src`, and only lines that markdown-it mapped to a table (quirk 1) or to the trailing
 * paragraph (quirk 2) are touched. Nothing here decides what is code — three review rounds of a
 * text-level pass showed that "is this line inside a fence" is the CommonMark block grammar
 * itself (indented fences in list items vs. indented backticks in prose), and markdown-it already
 * answered it. Returns the edited text, or null when no edit applies (then the first parse stands).
 */
export function normalizeTables(src, tokens) {
  if (src.indexOf('|') < 0) return null;
  const lines = src.split('\n');
  const edits = []; // { from, to, text }: lines[from..to] (inclusive) → one line `text`
  for (const t of tokens) {
    if (t.type !== 'table_open' || !t.map) continue;
    const [start, end] = t.map;
    // Body rows only (start = header, start + 1 = delimiter row — Codex 1R #3): a row start with
    // no closing pipe gathers the rows after it that do NOT start with `|` (markdown-it made each
    // a 1-cell row) until one ends with an unescaped pipe, within the line bound.
    for (let j = start + 2; j < end; j++) {
      const first = lines[j].trim();
      if (first[0] !== '|' || looksLikeRow(first)) continue;
      const parts = [first];
      let closed = -1;
      for (let k = j + 1; k < end && parts.length < MAX_TABLE_CELL_LINES; k++) {
        const u = lines[k].trim();
        if (!u || u[0] === '|') break;
        parts.push(u);
        if (u[u.length - 1] === '|' && !pipeEscapedAt(u, u.length - 1)) { closed = k; break; }
      }
      // The joined row keeps the first line's indent: a table inside a list item lives at the item's
      // content column, and a trimmed row would leave the item (Codex 4R).
      if (closed >= 0) { edits.push({ from: j, to: closed, text: /^[ \t]*/.exec(lines[j])[0] + parts.join(CELL_LINE_JOIN) }); j = closed; }
    }
  }
  // Quirk 2: the LAST block is a paragraph whose last line is a half-typed separator under a
  // complete row that is the first row of its block (Codex 1R #2: a body row of `-`/`:` cells or a
  // completed separator is left alone; a complete-looking tail narrower than the header —
  // `|---|` under `| a | b |` — is still in flight, one at least as wide is left as typed).
  let lastBlock = null;
  for (let i = tokens.length - 1; i >= 0; i--) { if (tokens[i].map && tokens[i].nesting !== -1 && tokens[i].type !== 'inline') { lastBlock = tokens[i]; break; } }
  if (lastBlock && lastBlock.type === 'paragraph_open') {
    const [s0, e0] = lastBlock.map;
    let last = e0 - 1;
    while (last > s0 && !lines[last].trim()) last--;
    if (last > s0) {
      const tail = lines[last].trim();
      const head = lines[last - 1].trim();
      const above = last - 2 >= s0 ? lines[last - 2].trim() : '';
      const headIsFirstRow = looksLikeRow(head) && !(above[0] === '|' && (looksLikeRow(above) || isSeparatorRow(above)));
      if (headIsFirstRow && TABLE_SEP_PREFIX_RE.test(tail) && (!looksLikeRow(tail) || rowWidth(tail) < rowWidth(head))) {
        edits.push({ from: last, to: last, text: '|' + '---|'.repeat(rowWidth(head)) });
      }
    }
  }
  if (!edits.length) return null;
  // Apply bottom-up so earlier line numbers stay valid.
  edits.sort((x, y) => y.from - x.from);
  for (const e of edits) lines.splice(e.from, e.to - e.from + 1, e.text);
  return lines.join('\n');
}

/** Build an <a> for a vetted http(s) target; the caller has already checked isSafeLinkTarget. */
function makeAnchor(url, d) {
  const a = d.createElement('a');
  a.setAttribute('href', url.trim());
  a.setAttribute('rel', 'noopener noreferrer');
  a.setAttribute('target', '_blank');
  return a;
}

// ── Inline TeX → Unicode (#1558) ────────────────────────────────────────────────────────────
// Gemini writes arrows and operators as LaTeX (`센소지 $\rightarrow$ 우에노`, `$3 \times 4$`,
// `$\approx 10^{-3}$`) and a markdown parser shows them verbatim. This is NOT a math renderer:
// a `$…$` / `$$…$$` span is rewritten to plain characters only when EVERY construct in it is one
// of the few below (symbols, `\text{}`-style wrappers, `\frac{a}{b}` → `a/b` with parens around a
// compound side, `^`/`_` with digits), and left exactly as typed otherwise
// (`$\frac{\partial f}{\partial x}$` stays TeX rather than becoming half-garbage).
//
// It is a markdown-it INLINE RULE (texRule, registered before `escape`), so it sees the RAW
// source: `\$x\$` is an escaped dollar (the escape rule wins because the tex rule never starts
// at a backslash), `\!` inside a span is TeX spacing and not a markdown escape, a `$` inside a
// code span is code (the backticks rule consumed it first), and `*…*` inside a span is not
// emphasis (Codex 1R #3). The output is one `text` token — characters, never markup.
// Prices are protected twice: a span must contain a command or a `^` script (an `_` alone does
// not qualify — `$file_1/$file_2` and `$50_1$` are shell variables and a price, Codex 1R #2), and
// its `$` delimiters cannot sit next to a space (`$5 and $10` has neither).
const TEX_SYMBOLS = {
  rightarrow: '→', to: '→', Rightarrow: '⇒', longrightarrow: '⟶', leftarrow: '←', Leftarrow: '⇐',
  leftrightarrow: '↔', Leftrightarrow: '⇔', uparrow: '↑', downarrow: '↓', mapsto: '↦',
  times: '×', div: '÷', cdot: '·', pm: '±', mp: '∓', ast: '∗', star: '★', bullet: '•',
  approx: '≈', neq: '≠', ne: '≠', le: '≤', leq: '≤', ge: '≥', geq: '≥', ll: '≪', gg: '≫',
  sim: '∼', simeq: '≃', equiv: '≡', propto: '∝', infty: '∞', circ: '°', degree: '°',
  sum: '∑', prod: '∏', int: '∫', sqrt: '√', partial: '∂', nabla: '∇', in: '∈', notin: '∉',
  subset: '⊂', subseteq: '⊆', supset: '⊃', cup: '∪', cap: '∩', emptyset: '∅', varnothing: '∅',
  forall: '∀', exists: '∃', neg: '¬', lnot: '¬', land: '∧', lor: '∨', therefore: '∴', because: '∵',
  ldots: '…', cdots: '⋯', dots: '…', vdots: '⋮', checkmark: '✓', prime: '′',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ',
  sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  // Spacing commands collapse to one space (or nothing); escaped punctuation is the character.
  quad: ' ', qquad: ' ', ',': ' ', ';': ' ', '!': '', ' ': ' ', '$': '$', '%': '%', '#': '#',
  // Escaped `_ { } &` are literal characters, but those characters also mean "not converted" to
  // the leftover check below — so they land as private-use stand-ins and are restored after it.
  '_': '\uE004', '{': '\uE005', '}': '\uE006', '&': '\uE007',
};
const TEX_LITERALS = { '\uE004': '_', '\uE005': '{', '\uE006': '}', '\uE007': '&' };
const TEX_LITERALS_RE = /[\uE004-\uE007]/g;
// `\text{x}` and friends: the argument is kept, the wrapper goes (one level of braces).
const TEX_WRAPPERS = new Set(['text', 'textbf', 'textit', 'textrm', 'mathrm', 'mathbf', 'mathit', 'mathsf', 'mathcal', 'operatorname', 'boldsymbol']);
const TEX_CMD_RE = /\\([a-zA-Z]+|[,;! $%&#_{}])/g;
const TEX_WRAPPER_RE = /\\([a-zA-Z]+)\{([^{}]*)\}/g;
const TEX_FRAC_RE = /\\d?frac\{([^{}]*)\}\{([^{}]*)\}/g;
// A frac side that needs no parens: one atom (`1`, `x`, `\pi`, `n`). `2+3` gets them (Codex 1R #1).
const TEX_ATOM_RE = /^(?:[\w.]+|\\[a-zA-Z]+)$/;
// `^{-3}` / `^2` / `_{10}` / `_i`: digits, sign and parens have Unicode super/subscripts; anything
// else (`^{n+k}` with a letter, `_{\max}`) leaves the span as typed. An escaped `\_` (as in
// `\text{file\_1}`) is a literal underscore, not a script (Codex 1R #4).
const TEX_SCRIPT_RE = /(?<!\\)([\^_])(?:\{([^{}]*)\}|([0-9a-zA-Z+\-]))/g;
const SUP = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ' };
const SUB = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '(': '₍', ')': '₎' };
export const TEX_MAX_SPAN = 300;

/** The plain-text form of one TeX span body, or null when any construct is not in the tables. */
export function texToText(body) {
  // Only spans with a command or a superscript are candidates — `5 and ` (a price range) and
  // `file_1/` (a shell variable) are not.
  if (!/[\\^]/.test(body)) return null;
  // Scripts first, on the raw body, so a `\_` inside a wrapper is still visibly escaped here.
  let out = body.replace(TEX_LITERALS_RE, '').replace(/\^\{?\\circ\}?/g, '°').replace(TEX_SCRIPT_RE, (m, kind, braced, single) => {
    const src = braced !== undefined ? braced : single;
    const table = kind === '^' ? SUP : SUB;
    let conv = '';
    for (const ch of src) { if (!Object.hasOwn(table, ch)) return m; conv += table[ch]; }
    return conv;
  });
  out = out.replace(TEX_FRAC_RE, (m, a, b) => `${TEX_ATOM_RE.test(a) ? a : `(${a})`}/${TEX_ATOM_RE.test(b) ? b : `(${b})`}`);
  out = out.replace(TEX_WRAPPER_RE, (m, cmd, arg) => (TEX_WRAPPERS.has(cmd) ? arg : m));
  out = out.replace(TEX_CMD_RE, (m, cmd) => (Object.hasOwn(TEX_SYMBOLS, cmd) ? TEX_SYMBOLS[cmd] : m));
  out = out.replace(/~/g, ' '); // TeX non-breaking space
  // Anything the tables did not cover (an unknown `\cmd`, a leftover brace or script marker, a
  // wrapper with nested braces, an alignment `&`) means the span stays TeX.
  if (/[\\{}^_&]/.test(out)) return null;
  return out.replace(TEX_LITERALS_RE, (c) => TEX_LITERALS[c]).replace(/ {2,}/g, ' ').trim();
}

/**
 * markdown-it inline rule: at a `$` (or `$$`) not followed by a space, with a closing delimiter on
 * the same line not preceded by a space, within TEX_MAX_SPAN chars, whose body converts — push
 * ONE text token and consume the span. Otherwise false, and the `$` is ordinary text.
 */
function texRule(state, silent) {
  const src = state.src;
  const pos = state.pos;
  if (src.charCodeAt(pos) !== 0x24 /* $ */) return false;
  const open = src.charCodeAt(pos + 1) === 0x24 ? 2 : 1;
  const first = src.charCodeAt(pos + open);
  if (first === 0x20 || first === 0x0A || Number.isNaN(first)) return false;
  let end = -1;
  // The body may be up to TEX_MAX_SPAN chars: the closer sits at most that far past the opener.
  const limit = Math.min(src.length, pos + open + TEX_MAX_SPAN + 1);
  for (let k = pos + open; k < limit; k++) {
    const c = src.charCodeAt(k);
    if (c === 0x0A) return false;
    // `](` is a link's label/destination seam: a span must not run from a label into its URL
    // (`[$5](https://x/a^2$)` — Codex 2R). In the label's silent pass this rule would otherwise
    // swallow the `]`, the link would never close, and the converted URL would autolink elsewhere.
    if (c === 0x5D /* ] */ && src.charCodeAt(k + 1) === 0x28 /* ( */) return false;
    if (c === 0x24) {
      if (open === 2 && src.charCodeAt(k + 1) !== 0x24) return false;
      end = k;
      break;
    }
  }
  if (end < 0 || src.charCodeAt(end - 1) === 0x20) return false;
  const conv = texToText(src.slice(pos + open, end));
  if (conv === null) return false;
  if (!silent) state.push('text', '', 0).content = conv;
  state.pos = end + open;
  return true;
}
md.inline.ruler.before('escape', 'tex', texRule);

/** `text` as text nodes, each wrapped `<br>` (see markBreaks) as a <br> element; stray marks dropped. */
function appendText(parent, text, d) {
  const parts = text.split(BR_WRAPPED_RE);
  parts.forEach((part, idx) => {
    if (idx > 0) parent.appendChild(d.createElement('br'));
    const plain = part.replace(BR_MARKS_RE, '');
    if (plain) parent.appendChild(d.createTextNode(plain));
  });
}

/** Code is verbatim: the marks go, the tag stays in the spelling the model typed. */
function unmarkBreaks(text) {
  return String(text).replace(BR_MARKS_RE, '');
}

// markdown-it percent-encodes the marks in a URL (U+E000 → %EE%80%80, U+E001 → %EE%80%81); the
// tag between them is already encoded as it would have been (`%3Cbr%3E`), so only the marks go.
const BR_MARKS_ENCODED_RE = /%EE%80%8[01]/g;
function unmarkHref(href) {
  return String(href || '').replace(BR_MARKS_ENCODED_RE, '').replace(BR_MARKS_RE, '');
}

/** A <pre><code data-lang=…> holding `content` as ONE text node. */
function codeBlock(token, d) {
  const pre = d.createElement('pre');
  const code = d.createElement('code');
  const lang = String(token.info || '').trim().split(/\s+/)[0];
  if (lang && LANG_RE.test(lang)) code.setAttribute('data-lang', lang);
  code.textContent = unmarkBreaks(token.content).replace(/\n$/, '');
  pre.appendChild(code);
  return pre;
}

/** Inline children of an `inline` token → nodes under `parent`. */
function emitInline(children, parent, d) {
  const stack = [parent];
  const top = () => stack[stack.length - 1];
  for (const c of children) {
    switch (c.type) {
      case 'text': appendText(top(), c.content, d); break;
      case 'softbreak': case 'hardbreak': top().appendChild(d.createElement('br')); break;
      case 'code_inline': { const code = d.createElement('code'); code.textContent = unmarkBreaks(c.content); top().appendChild(code); break; }
      case 'link_open': {
        const href = unmarkHref(c.attrGet('href'));
        if (isSafeLinkTarget(href)) { const a = makeAnchor(href, d); top().appendChild(a); stack.push(a); } else stack.push(top());
        break;
      }
      default:
        if (c.nesting === 1) {
          const el = d.createElement(TAGS.has(c.tag) ? c.tag : 'span');
          top().appendChild(el);
          stack.push(el);
        } else if (c.nesting === -1) {
          if (stack.length > 1) stack.pop();
        } else if (c.content) {
          // Any other leaf (a disabled rule's fallback, a plugin's token): its text, never markup.
          appendText(top(), c.content, d);
        }
    }
  }
}

/** Block tokens → nodes under `root`. Tight-list paragraphs (`hidden`) add no element. */
function emitBlocks(tokens, root, d) {
  const stack = [root];
  const top = () => stack[stack.length - 1];
  for (const t of tokens) {
    if (t.hidden) {
      if (t.nesting === 1) stack.push(top());
      else if (t.nesting === -1 && stack.length > 1) stack.pop();
      continue;
    }
    switch (t.type) {
      case 'inline': emitInline(t.children || [], top(), d); break;
      case 'fence': case 'code_block': top().appendChild(codeBlock(t, d)); break;
      case 'hr': top().appendChild(d.createElement('hr')); break;
      case 'table_open': {
        // compare.css scrolls a wide table inside its column via this wrapper.
        const wrap = d.createElement('div');
        wrap.className = 'md-table-wrap';
        const table = d.createElement('table');
        wrap.appendChild(table);
        top().appendChild(wrap);
        stack.push(table);
        break;
      }
      case 'th_open': case 'td_open': {
        const cell = d.createElement(t.tag === 'th' ? 'th' : 'td');
        // markdown-it carries GFM alignment as a style attr; only the three constant words land.
        const align = ALIGN_RE.exec(t.attrGet('style') || '');
        if (align) cell.setAttribute('data-align', align[1]);
        top().appendChild(cell);
        stack.push(cell);
        break;
      }
      default:
        if (t.nesting === 1) {
          const el = d.createElement(TAGS.has(t.tag) ? t.tag : 'div');
          if (t.type === 'ordered_list_open') {
            const start = t.attrGet('start');
            if (start && /^\d{1,9}$/.test(String(start))) el.setAttribute('start', String(start));
          }
          top().appendChild(el);
          stack.push(el);
        } else if (t.nesting === -1) {
          if (stack.length > 1) stack.pop();
        } else if (t.content) {
          appendText(top(), t.content, d);
        }
    }
  }
}

/** Render `text` (markdown) into a DocumentFragment of `doc`. Never throws on odd input. */
export function renderMarkdown(text, doc) {
  const d = doc || document;
  const frag = d.createDocumentFragment();
  let src = preClean(String(text == null ? '' : text).replace(/\r\n?/g, '\n'));
  let overflow = '';
  if (src.length > MAX_CHARS) { overflow = src.slice(MAX_CHARS); src = src.slice(0, MAX_CHARS); }
  src = markBreaks(src);
  try {
    let tokens = md.parse(src, {});
    // The quirks are planned from this parse's block map and, when one applies, the edited text is
    // parsed once more (only an answer with a multi-line cell or a streaming table start pays).
    const edited = normalizeTables(src, tokens);
    if (edited !== null) tokens = md.parse(edited, {});
    const body = d.createDocumentFragment();
    emitBlocks(tokens, body, d);
    frag.appendChild(body);
  } catch {
    // The tokenizer is bounded, but a failure must never blank the answer: the text, as text.
    frag.appendChild(d.createTextNode(src));
  }
  if (overflow) frag.appendChild(d.createTextNode(overflow));
  return frag;
}
