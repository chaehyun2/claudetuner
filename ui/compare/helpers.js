// ui/compare/helpers.js — the module-level helpers of the compare page (compare.js): pure
// functions that take every platform object they touch as an argument (chrome, window, a
// textarea) and close over nothing of mountComparePage(). Bodies as they were in compare.js;
// compare.js re-exports the public ones (listenEmbedTheme, sendableTargets, localHHMM).

import { COMPARE_PROVIDERS, COMPOSER_MAX_HEIGHT, EMBED_THEME_LIGHT, EMBED_THEME_DARK, FEEDBACK_CONTEXT_FIELD, FEEDBACK_CONTEXT_MAX, FEEDBACK_MODEL_UNKNOWN, FEEDBACK_COLUMN_RE, FEEDBACK_UA_RE, FEEDBACK_VERSION_RE, MODEL_ID_RE, STAGE_SEND_START, STAGE_FIRST_CHUNK, STAGE_STREAM_DONE, TTFT_MAX_MS } from './constants.js';

/**
 * The analytics id of an example prompt (the empty-state chips): FNV-1a 32-bit of its text as 8
 * hex digits — stable while the text is, and only OUR text goes in (a chip's `q`), never what the
 * user typed. `node scripts/compare-examples-ids.mjs` maps the ids back to cdn/compare-examples.json.
 */
export function exampleCode(q) {
  let h = 0x811c9dc5;
  for (const ch of String(q)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * The clicked example's id when `text` is that example sent as it was (trimmed) from the tab it was
 * offered on (`kind`: 'compare' | 'debate'), else null — an edited or a typed question, or a
 * cross-check chip started as a debate, reports no id. `clicked` = state.exampleClick ({q, code, kind} | null).
 */
export function exampleSentCode(clicked, text, kind) {
  return clicked && clicked.kind === kind && typeof clicked.q === 'string' && String(text || '').trim() === clicked.q.trim() ? clicked.code : null;
}

/**
 * Quoted model text is EVIDENCE, not instructions (Codex C5 2R #6): a line that could pass for a
 * fence or a heading (starts with `<<<` or `#`) is set off by one leading space — it still reads,
 * it no longer parses as structure. Used by 「요약·비교」 (summary.js) and the debate prompts (debate-core.js).
 */
export function neutraliseQuoted(text) {
  return String(text).split('\n').map((line) => (/^(<<<|#)/.test(line) ? ` ${line}` : line)).join('\n');
}

/** sendMessage as a promise, whether the fake/real runtime answers via callback or promise. */
export function sendMessage(chrome, msg) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const r = chrome.runtime.sendMessage(msg, (res) => { void chrome.runtime.lastError; done(res); });
      if (r && typeof r.then === 'function') r.then(done, () => done(undefined));
    } catch { done(undefined); }
  });
}

/** storage.get as a promise, whether the fake/real area answers via callback or promise; null on failure. */
export function storageGet(chrome, storage, keys) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v || null); } };
    try {
      const r = storage.get(keys, (res) => { void (chrome && chrome.runtime && chrome.runtime.lastError); done(res); });
      if (r && typeof r.then === 'function') r.then(done, () => done(null));
    } catch { done(null); }
  });
}

/** Local HH:MM for an ISO timestamp; '' when unparseable. */
export function localHHMM(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Vertical border of `el` in px (0 where there is no layout engine — mini-dom). */
export function borderY(el) {
  const view = el.ownerDocument && el.ownerDocument.defaultView;
  if (!view || typeof view.getComputedStyle !== 'function') return 0;
  const cs = view.getComputedStyle(el);
  return (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
}

/**
 * Auto-grow a composer textarea to its content, capped by COMPOSER_MAX_HEIGHT (then it scrolls).
 * `scrollHeight` excludes the border while the height we set includes it (the page is
 * border-box, compare.css `*`), so the border is added back — without it the box ends 2px short
 * and multi-line text shows a scrollbar (Codex 2R #3).
 */
export function autoGrow(textarea) {
  // 🔴 Item 4 (contract H): a textarea laid out at ZERO WIDTH — the page mounted inside a frame the
  // shell has not sized yet — wraps its placeholder / `?q` one character per line, so scrollHeight
  // is the cap (measured: 198 → the 200px cap committed at load, 46px after the first keystroke).
  // A height measured without a width is not a measurement: leave the box alone (min-height
  // rules) and let watchComposerWidth() re-run this once the textarea has a width.
  if (textarea.clientWidth === 0) return;
  textarea.style.height = 'auto';
  const h = textarea.scrollHeight;
  if (Number.isFinite(h) && h > 0) textarea.style.height = `${Math.min(h + borderY(textarea), COMPOSER_MAX_HEIGHT)}px`;
}

/**
 * Re-run autoGrow whenever the textarea's WIDTH changes (a frame that gets its size after load, a
 * composer that becomes visible, a window resize) — wrapping, and so the right height, depends on
 * the width. ResizeObserver where the platform has one (gated on the width so the height it sets
 * never re-triggers it), else `window.resize`. mini-dom has neither: nothing is installed.
 */
export function watchComposerWidth(textarea, win) {
  const RO = win && typeof win.ResizeObserver === 'function' ? win.ResizeObserver : null;
  if (RO) {
    let lastWidth = -1;
    try {
      new RO((entries) => {
        const width = entries && entries[0] && entries[0].contentRect ? entries[0].contentRect.width : textarea.clientWidth;
        if (width === lastWidth) return;
        lastWidth = width;
        autoGrow(textarea);
      }).observe(textarea);
      return;
    } catch { /* observe() refused — fall through to the window event */ }
  }
  if (win && typeof win.addEventListener === 'function') win.addEventListener('resize', () => autoGrow(textarea));
}

/**
 * Composer keys, shared by the question card and the follow-up box: Enter sends, Shift+Enter
 * breaks the line. An Enter that ends IME composition (Korean / Japanese input) must not send —
 * `isComposing` (or legacy keyCode 229) marks it. `onInput` runs after every edit (auto-grow done).
 */
export function bindComposer(textarea, onSend, onInput, win) {
  textarea.addEventListener('input', () => { autoGrow(textarea); if (onInput) onInput(); });
  textarea.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    onSend();
  });
  watchComposerWidth(textarea, win);
}

/** Providers the page may send to: permitted + logged in, minus the source when excluded. */
/** The web shell origin ui/embed-ready.js resolved for this frame, or null (not framed / not an allowed host). */
export function embedHostOf(win) {
  return win && typeof win.__ctEmbedHost === 'string' ? win.__ctEmbedHost : null;
}

/**
 * Framed by the web shell: apply `{__ctTheme:'light'|'dark'}` posted by the HOST page. Installed at
 * module evaluation — synchronously, before the async storage read that mounts the page — because
 * the shell posts the theme on the iframe's `load` event, which fires after this module ran but
 * possibly before that callback. 🔴 Both the origin AND the source window are pinned: accepted from
 * the framing page only, never from a sibling frame or an opener. Not framed → nothing is installed.
 */
export function listenEmbedTheme(win, doc) {
  const host = embedHostOf(win);
  if (!host || typeof win.addEventListener !== 'function') return false;
  win.addEventListener('message', (e) => {
    if (e.origin !== host || e.source !== win.parent) return;
    const theme = e.data && e.data.__ctTheme;
    if (theme === EMBED_THEME_LIGHT || theme === EMBED_THEME_DARK) doc.documentElement.setAttribute('data-theme', theme);
  });
  return true;
}

export function sendableTargets(status, src, excludeSrc) {
  if (!status || !status.providers) return [];
  return COMPARE_PROVIDERS.filter((p) => {
    const s = status.providers[p];
    if (!s || !s.permitted || !s.loggedIn) return false;
    if (excludeSrc && p === src) return false;
    return true;
  });
}

// ── feedback / report ──
// The link's target is built here, away from the DOM, so the guard can assert both halves without
// mounting a page: what the context block says, and what actually rides on the query string.

/**
 * The diagnostic block prefilled into the inquiry form's context field.
 *
 * 🔴 SHAPES, COUNTS AND IDS ONLY — never the question, an answer, a turn or an attachment's
 * contents. This is the same rule the analytics path lives under (compare.js track()), and here it
 * matters more: the form's answer is read by a human and stored in D1, so a leak is permanent.
 * The one free-text field of the form is the user's own message, which they write and can see.
 *
 * Lines the caller has nothing for are dropped rather than printed empty, and the whole block is
 * bounded at FEEDBACK_CONTEXT_MAX (the query string carries it).
 */
/**
 * A value that is NOT ours: it is printed only if it IS what it claims to be, and dropped whole
 * otherwise.
 *
 * 🔴 NEVER CUT (Codex 2R). The first fix stripped disallowed characters and truncated, which is
 * not validation — a 19-character `payroll-secret-1234` is a perfectly well-formed model id, and
 * the reviewer walked it through to a stored D1 row and a Telegram body. bg/compare.js already
 * says why cutting is the wrong tool for exactly this value: «a cut string is still that text».
 *
 * 🪤 Shape is not content, and this does not pretend otherwise: a string that really is shaped
 * like a model id still rides. That is the same exposure this repo already accepts for
 * `column_done.model` → GA4 (MODEL_ID_RE, Codex cmp-beta SW 1R #1), on purpose — knowing WHICH
 * model answered is most of a bad-answer report. What closes here is the prose, the markup and
 * the line forging; what remains is a ≤64-char token that looks like an id.
 */
export function feedbackValid(value, re) {
  return typeof value === 'string' && re.test(value) ? value : '';
}

/**
 * A column as `provider:model`, both validated: the provider against the page's own list, the
 * model against the id shape. A model that is not one reads `other` — the report still says a
 * model was pinned, without repeating whatever the provider called it.
 */
export function feedbackColumn(provider, model, providers = COMPARE_PROVIDERS) {
  if (!providers.includes(provider)) return '';
  if (model == null) return `${provider}:auto`;
  return `${provider}:${feedbackValid(model, MODEL_ID_RE) || FEEDBACK_MODEL_UNKNOWN}`;
}

export function feedbackContext(info, max = FEEDBACK_CONTEXT_MAX) {
  const i = info || {};
  // 🔴 RE-CHECKED HERE, not trusted from the caller. feedbackColumn() builds these, but this
  // function is the one that turns a value into a LINE, so it is the one that has to hold the
  // invariant — the guard caught a raw `'x\ny'` forging a line the moment validation lived only
  // at the call site (Codex 2R, self-inflicted by the 2R fix).
  const cols = (Array.isArray(i.columns) ? i.columns : []).filter((c) => feedbackValid(c, FEEDBACK_COLUMN_RE));
  const pairs = [
    ['Surface', 'AI Cross-Check (beta)'],
    ['Extension', feedbackValid(i.version, FEEDBACK_VERSION_RE)],
    // Which shell the user is looking at: the claudetuner.com iframe or a bare extension tab. The
    // two differ in what the page may do (a permission prompt, a popup), so a report that does not
    // say which one costs a round trip.
    ['Page', i.framed ? 'embedded (web shell)' : 'extension tab'],
    // Ours, every one of them: a literal, or a phrase this file composes from numbers.
    ['Language', i.lang === 'ko' || i.lang === 'en' ? i.lang : ''],
    ['Columns', cols.length ? cols.join(', ') : 'none'],
    ['Quota', i.quota],
    ['Rounds', Number.isFinite(i.rounds) ? String(i.rounds) : null],
    ['Asked from', COMPARE_PROVIDERS.includes(i.src) ? i.src : ''],
    ['UA', feedbackValid(i.ua, FEEDBACK_UA_RE)],
  ];
  const out = pairs
    .filter(([, v]) => typeof v === 'string' && v !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const cap = Number.isFinite(max) && max > 0 ? max : FEEDBACK_CONTEXT_MAX;
  return out.length > cap ? `${out.slice(0, cap)}…` : out;
}

export function feedbackUrl(base, fields) {
  const f = fields || {};
  const p = new URLSearchParams();
  if (f.source) p.set('source', f.source);
  if (f.name) p.set('user_name', f.name);
  if (f.email) p.set('user_email', f.email);
  if (f.context) p.set(FEEDBACK_CONTEXT_FIELD, f.context);
  const qs = p.toString();
  return qs ? `${base}?${qs}` : base;
}

/**
 * What one row of the picker says.
 *
 * 🔴 A MODEL NAME IS NOT A DESCRIPTION ANY MORE (user request 2026-09-25). chatgpt.com's picker
 * today offers Sol, Luna, Astra and Pro across two generations, and nothing in those words says
 * which one answers fast and which one thinks for a minute. The package hands us the model's
 * NAME and a stable ROLE beside it; the name tells three rows called Sol apart, and the role —
 * rendered here, in the reader's language — says what any of them is for.
 *
 * A provider that reports no role (Claude, Gemini, and any ChatGPT row whose category we have no
 * word for) keeps exactly the label it always had.
 *
 * Shared by the select, the pre-session list and the column face (2026-09-25): once the site's
 * power-stop titles became the labels (package v0.11.0) the face read 「Medium」 alone.
 */
export function modelOptionText(m, tr) {
  const name = typeof m.name === 'string' && m.name ? m.name : '';
  const role = typeof m.role === 'string' && m.role ? `model_role_${m.role}` : '';
  if (name && role && tr(role) !== role) return `${name} · ${tr(role)}`;
  return String(m.label || m.id || '');
}

/**
 * TRUE when the catalog says this account's plan cannot run the model (vendor-ai v0.15.0: Claude's
 * `available: false`, read from claude.ai's own plan gate — #1831). Such a model is SHOWN but not
 * selectable (user decision 2026-09-27): hiding it hides what an upgrade buys, and a selectable one
 * spends a send on 「지금은 이 모델을 쓸 수 없어요」. Only an explicit `false` locks — a catalog
 * without the field (static, Gemini, ChatGPT) locks nothing.
 */
export function modelLocked(m) {
  return !!m && typeof m === 'object' && m.available === false;
}

/**
 * The lock as the PAGE applies it, for a row of `list`: locked AND the list still has a runnable
 * row. A catalog with none locks nothing (a locked fallback would be sent anyway) — one rule for
 * the model select, the pre-session list, the service switch, 「＋ 열 추가」 and chooseColumn
 * (#1831 2R: two copies of the rule disagreed on an all-locked list).
 */
export function lockedInCatalog(list, m) {
  return Array.isArray(list) && list.some((x) => x && typeof x === 'object' && !modelLocked(x)) && modelLocked(m);
}

/** 「 · Pro 이상」 after a locked model's label ('' when unlocked or the tier is unnamed). */
export function lockedSuffix(m, tr) {
  if (!modelLocked(m) || typeof m.minimumTier !== 'string' || !m.minimumTier) return '';
  const tier = m.minimumTier.charAt(0).toUpperCase() + m.minimumTier.slice(1);
  return ` · ${tr('model_tier_needed', tier)}`;
}

/**
 * Text that must stay PLAIN inside markdown we hand out (copy export, debate markdown): every
 * markdown/HTML-significant character is backslash-escaped, so a provider's sentence quoted in a
 * note (e.g. a retraction, 1.49.x) cannot become a link, emphasis or an HTML tag in the copied text.
 */
const MD_INLINE_SPECIALS_RE = /[\\`*_[\]<>&~!]/g;
export function mdInlineText(text) {
  return String(text == null ? '' : text).replace(/[\r\n]+/g, ' ').replace(MD_INLINE_SPECIALS_RE, (c) => `\\${c}`);
}

/**
 * Whether a column's turn is a usable ANSWER: the column settled `done`, the turn has text, and the
 * provider did not RETRACT it (#1973 — Gemini can replace an answer it was writing with a fixed refusal;
 * the page shows the retraction, but the words that streamed are not an answer). One definition for the
 * debate transcript, the conclusion feedback and the review-banner "every column answered" moment
 * (1.49.3 batch review: a retracted Gemini opening was recorded as a normal debate turn and fed to the
 * next speaker).
 */
export function answeredTurn(col, turn) {
  return !!(col && col.status === 'done' && turn && !turn.retracted && typeof turn.text === 'string' && turn.text.trim());
}

/**
 * An answer's timing in whole ms from its round's timed stages: `{ first, total? }` — `first` =
 * first_chunk − send_start, `total` = stream_done − send_start. Null when `first` is missing or not
 * sane; `total` is omitted when its stage is missing or not sane. Never NaN, never negative, never
 * past the cap (the badge, the GA metrics, the history and the share all read this one value).
 */
export function answerTiming(stages, cap = TTFT_MAX_MS) {
  const st = stages || {};
  const s = st[STAGE_SEND_START];
  const sane = (ms) => Number.isFinite(ms) && ms >= 0 && ms <= cap;
  const first = st[STAGE_FIRST_CHUNK] - s;
  if (!sane(first)) return null;
  const total = st[STAGE_STREAM_DONE] - s;
  return { first: Math.round(first), ...(sane(total) && total >= first ? { total: Math.round(total) } : {}) };
}

/** A STORED timing (history / share input) re-read: the same shape as answerTiming's, or null. */
export function readTiming(v, cap = TTFT_MAX_MS) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const ok = (ms) => Number.isInteger(ms) && ms >= 0 && ms <= cap;
  if (!ok(v.first)) return null;
  return { first: v.first, ...(ok(v.total) && v.total >= v.first ? { total: v.total } : {}) };
}
