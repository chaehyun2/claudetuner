// ui/compare/debate-core.js — the pure core of 「토론 모드」 (docs/plans/compare-debate-mode.md, #1769):
// default aliases, alias validation, the per-speaker DELTA (what one AI is told on its turn), the
// three prompt builders, the moderator's control line and the next-speaker choice. No DOM, no
// chrome, no state of its own — every function takes what it reads, so test/compare-debate-guard.mjs
// drives it directly. The page side (ui/compare/debate.js) owns the transcript and the loop.
//
// Delivery model (the user's 「히스토리를 다 던지는 건 비효율」, 2026-09-26): every column is ONE
// real conversation on its site, so an AI already holds everything it said and everything it was
// told. A turn therefore carries only what happened SINCE THAT SPEAKER'S LAST TURN, minus its own
// words (deltaFor), and every prompt asks for a short answer — short turns are what keeps the
// deltas small. When a delta still runs over DEBATE_DELTA_MAX the newest items stay whole and the
// older ones shrink to an excerpt, then to a count (fitDelta).

import { neutraliseQuoted } from './helpers.js';
import { TURN_KIND_DEBATE, COMPARE_PROVIDERS, colIdOf } from './constants.js';

export const DEBATE_ALIAS_MAX = 20;
// Characters an alias may not hold: line breaks / controls, and everything that is structure in a
// debate prompt or in the page's own syntax — the fence (`<<<`, `>>>`), a heading (`#`), a code
// span, the mention sigil (`@`) and the control line separator (`:`). An alias is pasted into
// every prompt, so it must not be able to open or close anything.
// Brackets too (Codex meta 1R blocker): a header is `이름 (meta)`, and an alias that held its own
// parenthesis could not be told apart from the meta a moderator echoes back.
export const DEBATE_ALIAS_BAD_RE = /[\u0000-\u001f\u007f-\u009f<>`@:#\\()（）[\]{}]/;
// One quoted message at most this long (head kept, a marker says it was cut); the whole delta at
// most DEBATE_DELTA_MAX; an older message squeezed out of the budget keeps DEBATE_EXCERPT chars.
export const DEBATE_ITEM_MAX = 2500;
export const DEBATE_DELTA_MAX = 9000;
export const DEBATE_EXCERPT = 400;
export const DEBATE_TOPIC_MAX = 4000;
// Fixed characters one quoted message adds besides its name / meta / text: the two fence lines, the clip marker room.
const ITEM_FENCE_COST = 60;
export const DEBATE_MSG_OPEN = (n, name) => `<<<msg ${n}: ${name}>>>`;
export const DEBATE_MSG_CLOSE = (n) => `<<<end msg ${n}>>>`;

export const MOD_AI = 'ai';
export const MOD_AUTO = 'auto';
export const MOD_USER = 'user';
export const MODERATOR_KINDS = [MOD_AUTO, MOD_AI, MOD_USER];
export const STANCE_NONE = 'none';
export const STANCE_PRO_CON = 'procon';
export const STANCE_DEVIL = 'devil';
export const STANCES = [STANCE_NONE, STANCE_PRO_CON, STANCE_DEVIL];
// Tone (plan §12): how the AIs talk — like close friends (the default, 2026-09-26 user request),
// the calm debate wording of phases 1–2, or the user's own style line. Only the TASK sentences change
// with the tone; the quoting rule, identity / stance lines and the moderator's control line never do.
export const TONE_FRIENDS = 'friends';
export const TONE_CALM = 'calm';
export const TONE_CUSTOM = 'custom';
export const TONES = [TONE_FRIENDS, TONE_CALM, TONE_CUSTOM];
export const DEBATE_TONE_MAX = 300;
// The page's two tabs (plan §17, 2026-09-27): the same engine, two rooms. The mode is a page-level
// choice made before the first send; in a session the tab shows what the session is.
export const MODE_CROSSCHECK = 'crosscheck';
export const MODE_DEBATE = 'debate';
export const MODES = [MODE_CROSSCHECK, MODE_DEBATE];
// What a click on the other tab does (tabSwitchAction).
export const TAB_SWITCH = 'switch';
export const TAB_CONFIRM = 'confirm';
export const TAB_LOCKED = 'locked';

/**
 * The tab the page opens on: an explicit `mode` in the URL, else the cross-check when the page was
 * opened from a provider's in-page button (`src` — that user came to COMPARE the question they just
 * asked), else the last tab used (`stored`, the saved debate choice), else the cross-check.
 */
export function initialMode({ urlMode, src, stored }) {
  if (MODES.includes(urlMode)) return urlMode;
  if (src) return MODE_CROSSCHECK;
  return stored === true ? MODE_DEBATE : MODE_CROSSCHECK;
}

/**
 * What a click on the other tab does. Before the session: switch at once — unless a first send is on
 * the wire and not accepted yet (`sending` without `sessionStarted`): the port is live while the
 * page still counts as pre-session, so the tab is LOCKED (plan §17.11 ①). In a session the switch is
 * a new chat in the other mode; it asks first only when something would be lost — a round still
 * streaming / a debate still running, or a session with no history entry to come back to
 * (`kept === false`: 시크릿 대화, or a first round that has not settled yet — the entry is written
 * when a round settles). A paused debate reopens from the history (「계속」), so it does not ask.
 */
export function tabSwitchAction({ sessionStarted, sending, running, kept }) {
  if (!sessionStarted) return sending ? TAB_LOCKED : TAB_SWITCH;
  if (sending || running || kept === false) return TAB_CONFIRM;
  return TAB_SWITCH;
}

// ── the ⚙ settings (plan §18) ──
// The run's settings (moderator · stances · tone) sit behind the ⚙ in the debate tab; the defaults
// suit most first debates. What differs from them is said on the closed face (the summary line) so
// a changed setting never steers a debate unseen.
export const SETTING_MODERATOR = 'moderator';
export const SETTING_STANCE = 'stance';
export const SETTING_TONE = 'tone';
/**
 * The settings in `prefs` that differ from the defaults, in the order the panel shows them. `def` =
 * the default moderator for this page (defaultModerator — the plan-picked seat is a default, not a
 * change); the moderator counts as changed only when it names another kind or another column.
 */
export function changedSettings(prefs, def = { moderator: MOD_AUTO, modCol: null }) {
  const p = prefs || {};
  const out = [];
  const mod = p.moderator || MOD_AUTO;
  if (mod !== def.moderator || (mod === MOD_AI && (p.modCol || null) !== (def.modCol || null))) out.push(SETTING_MODERATOR);
  if ((p.stance || STANCE_NONE) !== STANCE_NONE) out.push(SETTING_STANCE);
  if ((p.tone || TONE_FRIENDS) !== TONE_FRIENDS) out.push(SETTING_TONE);
  return out;
}
// The start problems whose cause is a control inside the ⚙ panel (planCast's keys): with the panel
// closed they carry an 「설정 열기」 — the cards' own problems (a name clash, too few AIs) and a held
// link are fixed where they already show.
const SETTINGS_PROBLEMS = new Set(['debate_pick_moderator', 'debate_need_three_ai', 'debate_tone_err_empty', 'debate_tone_err_long']);
/** Whether a start problem (an i18n key) is fixed inside the ⚙ panel. */
export function problemInSettings(key) {
  return SETTINGS_PROBLEMS.has(key);
}

// ── the default moderator seat (plan §18.8) ──
// The debate tab's default is three debaters (one per service) plus a moderator column. The
// moderator speaks between every turn — about half a run's sends — so it is a FAST mid-tier model
// (a reasoning model costs 20–60 s and the user's limit per call; a too-light one breaks the
// `NEXT:` line). Its service: a paid plan first, then this order (user decision, 2026-09-27).
export const MODERATOR_RANK = ['chatgpt', 'claude', 'gemini'];
// Claude's moderator model by plan: Auto resolves to Sonnet 5 on a paid plan and Sonnet 4.6 on
// free (vendor-ai/models.js AUTO_LABELS) — the moderator asks for that model explicitly, so it is
// its own column beside the Claude debater's `claude:auto`.
export const CLAUDE_MODERATOR_PAID = 'claude-sonnet-5';
export const CLAUDE_MODERATOR_FREE = 'claude-sonnet-4-6';
/** A plan label (status.providers[p].plan) is a paid plan: present and not 「Free」 — renderPlan's `data-tier` rule. */
export const isPaidPlan = (label) => typeof label === 'string' && !!label.trim() && !/^free$/i.test(label.trim());
const catalogIds = (list) => (Array.isArray(list) ? list.filter((m) => m && typeof m === 'object' && m.id != null && m.id !== '').map((m) => ({ id: String(m.id), label: String(m.label || ''), default: m.default === true })) : []);
/**
 * Where the default moderator sits, from the status (`providers[p]` = { loggedIn, permitted, plan },
 * `catalogs[p]` = the model list): `{ provider, model, debaterModel }` — `model` is always an
 * explicit id (an `auto` column takes the stored model seed, which may be a slow one — plan §18.9 ②);
 * `debaterModel` = the model the SAME service's debater then uses instead of Auto (ChatGPT: its
 * Auto IS the default Instant the moderator takes, so its debater moves to Thinking), else null.
 * Null when no signed-in service offers a moderator model.
 */
export function pickModeratorSeat({ providers, catalogs }) {
  const ps = providers || {};
  const cats = catalogs || {};
  const ready = MODERATOR_RANK.filter((p) => ps[p] && ps[p].loggedIn === true && ps[p].permitted === true);
  // Stable: paid first, the rank order within each group.
  const order = [...ready.filter((p) => isPaidPlan(ps[p].plan)), ...ready.filter((p) => !isPaidPlan(ps[p].plan))];
  for (const p of order) {
    const list = catalogIds(cats[p]);
    const tierOfRow = (m) => defaultAliasOf(p, m.id, m.label);
    if (p === 'claude') {
      const want = isPaidPlan(ps[p].plan) ? CLAUDE_MODERATOR_PAID : CLAUDE_MODERATOR_FREE;
      if (list.some((m) => m.id === want)) return { provider: p, model: want, debaterModel: null };
    } else if (p === 'gemini') {
      const flash = list.find((m) => tierOfRow(m).family === 'debate_family_flash');
      if (flash) return { provider: p, model: flash.id, debaterModel: null };
    } else if (p === 'chatgpt') {
      // The catalog's default row, only when it is the fast Instant; the debater takes the first Thinking row.
      const def = list.find((m) => m.default);
      const think = list.find((m) => tierOfRow(m).tier === TIER_REASONING);
      if (def && tierOfRow(def).family === 'debate_family_instant' && think) return { provider: p, model: def.id, debaterModel: think.id };
    }
  }
  return null;
}
/**
 * The debate tab's default layout (no stored `debateColumns`): one debater per service in page
 * order — Auto, or the seat's `debaterModel` for its own service — then the moderator seat last.
 * `{ ids, seat }`; no seat → the three debaters and `seat: null` (plan §18.8).
 */
export function defaultDebateLayout(pick) {
  const ids = COMPARE_PROVIDERS.map((p) => colIdOf(p, pick && pick.provider === p ? pick.debaterModel : null));
  if (!pick) return { ids, seat: null };
  const seat = colIdOf(pick.provider, pick.model);
  return ids.includes(seat) ? { ids, seat: null } : { ids: [...ids, seat], seat };
}
/**
 * The moderator a debate starts with when the user never chose one (`modChosen` false): the seat,
 * while it is among the targets with at least two debaters besides it (a service not signed in
 * leaves three — the seat still moderates rather than debating its own service); else the auto order.
 */
export function defaultModerator(seat, targets) {
  const list = Array.isArray(targets) ? targets : [];
  return seat && list.includes(seat) && list.length >= DEFAULT_MOD_MIN_TARGETS ? { moderator: MOD_AI, modCol: seat } : { moderator: MOD_AUTO, modCol: null };
}
// Two debaters plus the seat — the same floor as a chosen AI moderator (planCast). A seat exists only
// in the layout it was picked with (the default one, or a stored one saved with it — plan §18.9 ①).
const DEFAULT_MOD_MIN_TARGETS = 3;

export const SPEAKER_USER = 'user';
export const ROLE_USER = 'user';
export const ROLE_PARTICIPANT = 'participant';
export const ROLE_MODERATOR = 'moderator';

// ── aliases ──
// Default aliases keep the MODEL's name (2026-09-26 user request — 「완전 랜덤보다 원래 모델 이름을
// 살려라」): `<trait> <model name>` — 거장 오퍼스 / Maestro Opus, 번개 제미 / Lightning Gemini (2026-09-27:
// the trait comes from what the model's name means, and the service stays readable — the earlier
// `<family word> <animal>` names left 「프로 독수리」 vs 「프로 여우」 unattributable). The family
// is read from the id's TOKENS plus the catalog LABEL (plan §11.4 ①): Gemini ids are hashes
// (`56fdd199312815e2` = 「3.6 Flash」, vendor-ai/models.js), so an id-only rule never saw its family.
// Per service the first rule whose token matches wins (ChatGPT: pro > thinking > instant > mini —
// code names such as sol / luna / astra are ignored, `gpt-5-6-luna-instant` is instant). `key` is the
// i18n key of the name (copy, both languages), `family` the i18n key of the family word a mention may
// use (`@오퍼스`, `@opus`), `emoji` the avatar — never sent to an AI. The rule without tokens is the
// service's Auto / unknown family.
const TIER_HIGH = 'debate_tier_high';
const TIER_REASONING = 'debate_tier_reasoning';
const TIER_BALANCED = 'debate_tier_balanced';
const TIER_LIGHT = 'debate_tier_light';
// `tier` (plan §13 / §13.1 ①⑤): a hand-made MODEL-GROUP hint, worded as an estimate (고성능군 / 추론형
// / 균형형 / 경량형) — never a benchmark claim. null = no grounds to say (Auto, and the Work models
// Sol / Luna / Terra until there is evidence; Astra is 고성능군 on the recorded evidence that it is
// the much heavier model draining the same quota — docs/CHATGPT-USAGE-SEMANTICS.md).
const DEFAULT_ALIAS_RULES = {
  claude: [
    { tokens: ['fable'], key: 'debate_alias_claude_fable', family: 'debate_family_fable', emoji: '\u{1F4D6}', tier: TIER_HIGH },         // open book (fable = a tale)
    { tokens: ['opus'], key: 'debate_alias_claude_opus', family: 'debate_family_opus', emoji: '\u{1F3BB}', tier: TIER_HIGH },            // violin (opus = a work; the black score vanished on the dark tile)
    { tokens: ['sonnet'], key: 'debate_alias_claude_sonnet', family: 'debate_family_sonnet', emoji: '\u{1FAB6}', tier: TIER_BALANCED },  // quill (sonnet = a poem)
    { tokens: ['haiku'], key: 'debate_alias_claude_haiku', family: 'debate_family_haiku', emoji: '\u{1F343}', tier: TIER_LIGHT },        // leaf (haiku = a short poem)
    { tokens: null, key: 'debate_alias_claude', family: null, emoji: '\u{1F39B}\u{FE0F}', tier: null },                                  // knobs (auto)
  ],
  chatgpt: [
    { tokens: ['pro'], key: 'debate_alias_chatgpt_pro', family: 'debate_family_pro', emoji: '\u{1F393}', tier: TIER_HIGH },                                          // mortarboard (Pro → Professor)
    { tokens: ['thinking', 'reasoning', /^o\d+$/], key: 'debate_alias_chatgpt_thinking', family: 'debate_family_thinking', emoji: '\u{1F914}', tier: TIER_REASONING }, // thinking face
    { tokens: ['instant'], key: 'debate_alias_chatgpt_instant', family: 'debate_family_instant', emoji: '\u{1F4A8}', tier: TIER_LIGHT },                             // dash
    { tokens: ['mini', 'nano'], key: 'debate_alias_chatgpt_mini', family: 'debate_family_mini', emoji: '\u{1F423}', tier: TIER_LIGHT },                              // hatching chick
    // Work-mode models (`gpt-6-astra-wm` …, docs/DESIGN-chatgpt-model-surface.md §D — sendable).
    { tokens: ['astra'], key: 'debate_alias_chatgpt_astra', family: 'debate_family_astra', emoji: '\u{2B50}', tier: TIER_HIGH },                                     // star (astra)
    { tokens: ['sol'], key: 'debate_alias_chatgpt_sol', family: 'debate_family_sol', emoji: '\u{2600}\u{FE0F}', tier: null },                                       // sun (sol)
    { tokens: ['luna'], key: 'debate_alias_chatgpt_luna', family: 'debate_family_luna', emoji: '\u{1F319}', tier: null },                                            // moon (luna)
    { tokens: ['terra'], key: 'debate_alias_chatgpt_terra', family: 'debate_family_terra', emoji: '\u{1F30D}', tier: null },                                         // earth (terra)
    { tokens: null, key: 'debate_alias_chatgpt', family: null, emoji: '\u{1F4AC}', tier: TIER_BALANCED },                                                            // speech balloon (chat)
  ],
  gemini: [
    { tokens: ['thinking'], key: 'debate_alias_gemini_thinking', family: 'debate_family_thinking', emoji: '\u{1F9E0}', tier: TIER_REASONING }, // brain
    { tokens: ['flash', 'lite'], key: 'debate_alias_gemini_flash', family: 'debate_family_flash', emoji: '\u{26A1}', tier: TIER_LIGHT },       // lightning (flash)
    { tokens: ['pro', 'ultra'], key: 'debate_alias_gemini_pro', family: 'debate_family_pro', emoji: '\u{1F52C}', tier: TIER_HIGH },            // microscope (expert)
    { tokens: null, key: 'debate_alias_gemini', family: null, emoji: '\u{264A}\u{FE0F}', tier: null },                                         // gemini sign (twins)
  ],
};
export const TIER_KEYS = [TIER_HIGH, TIER_REASONING, TIER_BALANCED, TIER_LIGHT];
const TIER_KEY_PREFIX = 'debate_tier_';
/** A tier i18n key as a short analytics value (`debate_tier_light` → `light`); '' for none. */
export const tierSlug = (key) => (typeof key === 'string' && key.startsWith(TIER_KEY_PREFIX) ? key.slice(TIER_KEY_PREFIX.length) : '');
const FALLBACK_ALIAS = { key: 'debate_alias_other', family: null, emoji: '\u{1F916}', tier: null };
/** Every default-alias i18n key (the guard checks each exists in both languages and fits DEBATE_ALIAS_MAX). */
export const DEFAULT_ALIAS_KEYS = [...Object.values(DEFAULT_ALIAS_RULES).flat().map((r) => r.key), FALLBACK_ALIAS.key];
export const FAMILY_WORD_KEYS = [...new Set(Object.values(DEFAULT_ALIAS_RULES).flat().map((r) => r.family).filter(Boolean))];
// The brand spelling of each family word, accepted in a mention in EITHER page language (`@opus` on a
// Korean page, `@오퍼스` comes from the ko table). ASCII only — Hangul stays in compare-i18n.js.
const FAMILY_BRAND = { debate_family_fable: 'Fable', debate_family_opus: 'Opus', debate_family_sonnet: 'Sonnet', debate_family_haiku: 'Haiku', debate_family_pro: 'Pro', debate_family_thinking: 'Thinking', debate_family_instant: 'Instant', debate_family_mini: 'Mini', debate_family_flash: 'Flash', debate_family_astra: 'Astra', debate_family_sol: 'Sol', debate_family_luna: 'Luna', debate_family_terra: 'Terra' };
/** The words a mention may use for a family: its localized word and its brand spelling (deduped). */
function familyWords(key, t) {
  return key ? [...new Set([t(key), FAMILY_BRAND[key]].filter(Boolean))] : [];
}

/** The lower-case tokens of a model id + label (`gpt-5-6-luna-instant`, `3.6 Flash` → …, `flash`). */
function modelTokens(modelId, modelLabel) {
  return `${modelId == null ? '' : modelId} ${modelLabel == null ? '' : modelLabel}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
/** `{ key, family, emoji }` of the default alias for a provider + model id + catalog label (null / '' = Auto). */
export function defaultAliasOf(provider, modelId, modelLabel = '') {
  const rules = DEFAULT_ALIAS_RULES[provider];
  if (!rules) return FALLBACK_ALIAS;
  const toks = modelTokens(modelId, modelLabel);
  const hit = (want) => toks.some((tok) => (want instanceof RegExp ? want.test(tok) : tok === want));
  for (const r of rules) if (!r.tokens || r.tokens.some(hit)) return { key: r.key, family: r.family, emoji: r.emoji, tier: r.tier };
  return FALLBACK_ALIAS;
}
/**
 * The tier i18n key of a model, or null. `modelId` null = Auto: then only a model the SITE REPORTED
 * serving (`served`, `{ id, label }` — never a merely requested one) may name the family (§13.1 ②).
 */
export function tierOf(provider, modelId, modelLabel, served = null) {
  if (modelId != null && modelId !== '') return defaultAliasOf(provider, modelId, modelLabel).tier;
  if (served && (served.id || served.label)) return defaultAliasOf(provider, served.id, served.label).tier;
  return null;
}
export const DEBATE_META_MAX = 60;
/** A header fragment made safe: no brackets / angle brackets / colon / controls, one line, bounded. */
export function cleanMeta(s) {
  return String(s == null ? '' : s).replace(/[()<>:\[\]{}\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, DEBATE_META_MAX);
}
/** Whole seconds from `start` to `done` (ms timestamps), or null when either is missing, reversed or over `cap` (§13.1 ③). */
export function secondsBetween(start, done, cap) {
  const ms = done - start;
  if (!Number.isFinite(start) || !Number.isFinite(done) || !Number.isFinite(ms) || ms < 0 || ms > cap) return null;
  return Math.max(1, Math.round(ms / 1000));
}
/** `Claude Opus 5.5 · 고성능군 · 41초 걸림` from what is known (each part optional), cleaned. */
export function metaLine({ label, tierKey, secs }, t) {
  // The WHOLE meta stays within DEBATE_META_MAX (Codex meta 1R 후속): the group and the time are
  // short and kept; the model label gives up whatever room they need.
  const SEP = ' \u00B7 ';
  const rest = [tierKey ? t(tierKey) : '', Number.isFinite(secs) ? t('debate_meta_secs', secs) : ''].map(cleanMeta).filter(Boolean);
  const room = DEBATE_META_MAX - rest.reduce((n, r) => n + r.length + SEP.length, 0);
  const lab = cleanMeta(label).slice(0, Math.max(0, room)).trim();
  return [lab, ...rest].filter(Boolean).join(SEP).slice(0, DEBATE_META_MAX);
}

/** Every line quoted, the first one carrying `first` — a line break cannot leave the quote (export.js's rule). */
const quoteMd = (text, first = '') => String(text).split('\n').map((line, i) => `> ${i === 0 ? first : ''}${line}`).join('\n');
/**
 * A debate session as ONE markdown document (「전체 복사」, #1769 §0.4 ⑤): the topic, then what the
 * timeline SHOWS, in its order — never the composed prompts the columns' user turns carry (they
 * would read as the user's questions) nor a moderator's control line (`text` is the shown body).
 *   entries: { role, name, text, meta?, note?, opening? } — `note` is the line a failed / cut turn
 *            shows under whatever it wrote; an entry with neither text nor note is left out.
 */
export function debateMarkdown({ topic, entries }, t) {
  const qLines = String(topic || '').split('\n');
  const blocks = [`# ${qLines[0]}`];
  if (qLines.length > 1) blocks.push(quoteMd(topic));
  let openingShown = false;
  for (const e of entries) {
    const text = String(e.text || '').replace(/\s+$/, '');
    const note = String(e.note || '').trim();
    if (!text.trim() && !note) continue;
    if (e.opening && !openingShown) { blocks.push(`_${t('debate_opening_divider')}_`); openingShown = true; }
    if (e.role === ROLE_USER) { blocks.push(quoteMd(text, `**${e.name}:** `)); continue; }
    const name = e.role === ROLE_MODERATOR ? t('debate_name_moderator', e.name) : e.name;
    blocks.push(`**${name}**${e.meta ? ` \u00B7 ${e.meta}` : ''}`);
    if (text.trim()) blocks.push(text);
    if (note) blocks.push(`_${note}_`);
  }
  return blocks.join('\n\n');
}

/** The version a model label carries (`Opus 5.5` → `5.5`, `GPT-5.6 Thinking` → `5.6`), or ''. */
export function versionOf(modelLabel) {
  const m = /\d+(?:\.\d+)*/.exec(String(modelLabel || ''));
  return m ? m[0] : '';
}

/** The user's style line: every run of whitespace / control characters folded to one space, trimmed. */
export function cleanTone(raw) {
  // C0 + DEL + C1 (U+0085 NEL is a line break too — Codex chat 2R 후속); \s already covers U+2028/2029.
  return String(raw == null ? '' : raw).replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
}
/** Why `raw` cannot be the custom style line: 'empty', 'long', or null. */
export function toneProblem(raw) {
  const s = cleanTone(raw);
  if (!s) return 'empty';
  if ([...s].length > DEBATE_TONE_MAX) return 'long';
  return null;
}
/** `{ kind, custom }` from stored / chosen values: unknown kind = friends; a custom line that fails toneProblem is dropped to ''. */
export function normalizeTone(kind, custom) {
  const k = TONES.includes(kind) ? kind : TONE_FRIENDS;
  const c = cleanTone(custom);
  return { kind: k, custom: c && !toneProblem(c) ? c : '' };
}
/** The style line a custom tone appends (scoped to tone and wording), or null for the built-in tones. */
function styleLine(tone, t, forModerator) {
  if (!tone || tone.kind !== TONE_CUSTOM || !tone.custom) return null;
  return t(forModerator ? 'debate_style_line_mod' : 'debate_style_line', neutraliseQuoted(cleanTone(tone.custom)));
}
const friendly = (tone) => !tone || tone.kind === TONE_FRIENDS;

/** A user-typed alias, trimmed and whitespace-collapsed; '' stays '' (= use the default). */
export function cleanAlias(raw) {
  return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
}
/** Why `raw` cannot be an alias: null (fine, or empty = default), 'long' or 'chars'. */
export function aliasProblem(raw) {
  const s = cleanAlias(raw);
  if (!s) return null;
  if ([...s].length > DEBATE_ALIAS_MAX) return 'long';
  if (DEBATE_ALIAS_BAD_RE.test(s)) return 'chars';
  return null;
}
/**
 * The key two names are compared by (uniqueness, mentions, the moderator's NEXT line): letters and
 * digits only, lower-cased — spaces, emoji, quotes, brackets and punctuation do not tell names apart.
 */
export function nameKey(s) {
  return String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * The debate names of `people` (`[{ id, provider, model, modelLabel, alias, label }]` — `alias` the
 * stored user alias or '', `label` the page's own 「Claude (Opus 5)」, `modelLabel` the catalog label
 * 「Opus 5」): `{ names: Map id → { name, emoji, custom, words }, conflicts: [id] }` (`words` = family words a mention may use). Colliding
 * defaults are told apart by version / label / number (below); two
 * CUSTOM aliases that collide (or a custom alias equal to another participant's label) are a
 * conflict the page must refuse to start with — mentions and NEXT lines could not tell them apart.
 */
export function resolveNames(people, t) {
  const names = new Map();
  const taken = new Map(); // nameKey → id
  const conflicts = new Set();
  const stripTail = (x) => String(x || '').replace(/\s*[(（\[].*$/, '');
  // A custom alias may equal neither another participant's label nor that label's head before its
  // bracket (`Claude` beside `Claude (Opus 5)`) — both are names a moderator can write (Codex meta 4R).
  const labelKeys = new Map(people.map((p) => [p.id, [nameKey(p.label), nameKey(stripTail(p.label))]]));
  // Custom aliases first, so a default never takes a name the user chose.
  for (const p of people) {
    const alias = cleanAlias(p.alias);
    if (!alias || aliasProblem(alias)) continue;
    const k = nameKey(alias);
    const clashLabel = people.some((o) => o.id !== p.id && labelKeys.get(o.id).includes(k));
    if (!k || taken.has(k) || clashLabel) {
      conflicts.add(p.id);
      if (taken.has(k)) conflicts.add(taken.get(k));
      continue;
    }
    taken.set(k, p.id);
    { const d = defaultAliasOf(p.provider, p.model, p.modelLabel); names.set(p.id, { name: alias, emoji: d.emoji, custom: true, words: familyWords(d.family, t) }); }
  }
  // Defaults: a family shared by several participants (or whose name a custom alias took) names
  // each of them by its version, then by its whole label, then by a number (plan §11.4 ②) — the
  // real model stays readable in the name, and two Opus columns never read as the same speaker.
  const defs = people.filter((p) => !names.has(p.id)).map((p) => ({ p, def: defaultAliasOf(p.provider, p.model, p.modelLabel) }));
  const baseCount = new Map();
  for (const { def } of defs) { const b = nameKey(t(def.key)); baseCount.set(b, (baseCount.get(b) || 0) + 1); }
  for (const { p, def } of defs) {
    const base = t(def.key);
    const shared = baseCount.get(nameKey(base)) > 1 || taken.has(nameKey(base));
    // Every generated name stays within DEBATE_ALIAS_MAX (Codex chat 1R 후속: `Thinking Penguin
    // GPT-5.6 Thinking Fast` was 38): a try that would run over is skipped, the number always fits.
    const fits = (n) => [...n].length <= DEBATE_ALIAS_MAX;
    const tries = (shared ? [versionOf(p.modelLabel) && `${base} ${versionOf(p.modelLabel)}`, p.modelLabel && `${base} ${p.modelLabel}`] : [base]).filter((n) => n && fits(n));
    let name = tries.find((n) => !taken.has(nameKey(n)));
    for (let n = 2; !name; n++) if (!taken.has(nameKey(`${base} ${n}`))) name = `${base} ${n}`; // base ≤ 17 (guard) + ` n` fits
    taken.set(nameKey(name), p.id);
    names.set(p.id, { name, emoji: def.emoji, custom: false, words: familyWords(def.family, t) });
  }
  return { names, conflicts: [...conflicts] };
}

// ── delta ──
/**
 * What `speaker` has not seen: every transcript entry after `sinceSeq` that is not its own, in
 * order. `transcript` = `[{ seq, speaker, role, name, text }]`; the moderator's control line is
 * already stripped from its text (the page stores the display body).
 */
export function deltaFor(transcript, speaker, sinceSeq) {
  return transcript.filter((e) => e.seq > sinceSeq && e.speaker !== speaker && String(e.text || '').trim());
}

const clip = (text, max) => {
  const s = String(text || '');
  return s.length > max ? { text: s.slice(0, max), clipped: true } : { text: s, clipped: false };
};
/**
 * The delta, fitted to the budget: `{ items: [{ name, role, text, clipped }], omitted }`. Every
 * item is cut at DEBATE_ITEM_MAX. If the total still exceeds `budget`, items are shrunk OLDEST
 * FIRST to DEBATE_EXCERPT, then dropped oldest first (counted in `omitted`) — except the user's
 * words and the newest moderator message, which are what the speaker is being asked to answer.
 * The newest item is never shrunk (it is usually the one to rebut).
 */
export function fitDelta(entries, budget = DEBATE_DELTA_MAX) {
  let items = entries.map((e) => ({ name: e.name, role: e.role, meta: e.meta || '', ...clip(e.text, DEBATE_ITEM_MAX) }));
  const lastMod = items.map((i) => i.role).lastIndexOf(ROLE_MODERATOR);
  const protectedAt = (i) => i === items.length - 1 || items[i].role === ROLE_USER || i === lastMod;
  // The whole quoted block counts, not just the words (§13.1 ④): its fence lines, name and meta header.
  const cost = (i) => i.text.length + String(i.name || '').length + i.meta.length + ITEM_FENCE_COST;
  const total = () => items.reduce((n, i) => n + (i ? cost(i) : 0), 0);
  for (let i = 0; i < items.length && total() > budget; i++) {
    if (protectedAt(i) || items[i].text.length <= DEBATE_EXCERPT) continue;
    items[i] = { ...items[i], text: items[i].text.slice(0, DEBATE_EXCERPT), clipped: true };
  }
  let omitted = 0;
  for (let i = 0; i < items.length && total() > budget; i++) {
    if (protectedAt(i)) continue;
    items[i] = null;
    omitted++;
  }
  // Still over (the protected items alone — several long user messages — exceed it; Codex meta 1R
  // 후속): older protected items shrink to excerpts, then go, oldest first. The newest item is kept
  // whole — DEBATE_ITEM_MAX + one header stays far under any sensible budget.
  const last = items.length - 1;
  for (let i = 0; i < last && total() > budget; i++) {
    if (items[i] && items[i].text.length > DEBATE_EXCERPT) items[i] = { ...items[i], text: items[i].text.slice(0, DEBATE_EXCERPT), clipped: true };
  }
  for (let i = 0; i < last && total() > budget; i++) {
    if (items[i]) { items[i] = null; omitted++; }
  }
  items = items.filter(Boolean);
  return { items, omitted };
}

/** The fenced messages block of a prompt (every message neutralised: evidence, not instructions). */
function renderItems(items, t) {
  const out = [];
  items.forEach((it, i) => {
    // One parenthesis per header: the moderator's role word joins its meta (`이름 (진행자 · Gemini …)`).
    let who;
    if (it.role === ROLE_USER) who = t('debate_name_user');
    else if (it.role === ROLE_MODERATOR) who = `${it.name} (${[t('debate_role_moderator'), it.meta].filter(Boolean).join(' \u00B7 ')})`;
    else who = it.meta ? `${it.name} (${it.meta})` : it.name;
    out.push(DEBATE_MSG_OPEN(i + 1, who));
    out.push(neutraliseQuoted(it.text) + (it.clipped ? `\n${t('debate_clipped')}` : ''));
    out.push(DEBATE_MSG_CLOSE(i + 1));
  });
  return out.join('\n');
}

// ── stances ──
/** The stance i18n key of each debater (`ids` in speaking order) under `stance`; Map id → key | null. */
export function stancesOf(ids, stance) {
  const out = new Map(ids.map((id) => [id, null]));
  if (stance === STANCE_PRO_CON) ids.forEach((id, i) => out.set(id, i % 2 === 0 ? 'debate_stance_pro' : 'debate_stance_con'));
  else if (stance === STANCE_DEVIL && ids.length) out.set(ids[ids.length - 1], 'debate_stance_devil');
  return out;
}

// ── prompts ──
// Every prompt carries `debate_call_full_name` (2026-09-27): default names are `<trait> <model>`
// (쌍둥이 제미, 교수 GPT), and a model reads the trait as a title and calls the speaker by the tail
// alone — 「제미 님」「GPT 님」 — which names nobody once two of a service take part.
/**
 * The opening: the same text to every debater (the first SEND carries ONE text), so it names the
 * cast but not the reader — each AI learns its own name on its first reply turn. Everyone answers
 * blind (nobody has seen anyone else yet), which is the point of opening simultaneously.
 */
export function openingPrompt({ t, names, moderatorName, stanceLines, topic, tone }) {
  const lines = [t('debate_open_head', names.join(', ')), t('debate_call_full_name'), moderatorName ? t('debate_open_moderator', moderatorName) : t('debate_open_user_moderates')];
  if (stanceLines && stanceLines.length) lines.push(t('debate_open_stances'), ...stanceLines);
  lines.push(t(friendly(tone) ? 'debate_open_task_friends' : 'debate_open_task'));
  const style = styleLine(tone, t, false);
  if (style) lines.push(style);
  lines.push('', t('debate_topic_label'), neutraliseQuoted(String(topic || '').slice(0, DEBATE_TOPIC_MAX)));
  return lines.join('\n');
}
/**
 * A debater's turn: who it is, what was said since it last spoke, what it is asked. `instruction`
 * = the moderator's question to it (or null); `firstReply` = its first turn after the opening —
 * the only place its own name is introduced (the opening could not: it was one text for all).
 */
export function turnPrompt({ t, selfName, stanceKey, delta, instruction, firstReply, tone }) {
  const lines = [];
  if (firstReply) lines.push(t('debate_turn_you_are', selfName) + (stanceKey ? ` ${t('debate_turn_stance', t(stanceKey))}` : ''));
  lines.push(t('debate_turn_head'));
  if (delta.items.length) lines.push(renderItems(delta.items, t));
  if (delta.omitted) lines.push(t('debate_omitted', delta.omitted));
  if (instruction) lines.push(t('debate_turn_instruction', neutraliseQuoted(instruction)));
  lines.push(t(friendly(tone) ? 'debate_turn_task_friends' : 'debate_turn_task'));
  lines.push(t('debate_call_full_name'));
  const style = styleLine(tone, t, false);
  if (style) lines.push(style);
  return lines.join('\n');
}
/**
 * The moderator's turn. It must not argue, it summarises and hands the floor to ONE debater, and
 * its reply ends with a control line (MODERATOR_CONTROL_RE) the page parses and hides.
 * `first` = its first call (it has not seen the topic yet, so it gets it here).
 */
export function moderatorPrompt({ t, names, lastName, delta, first, topic, canEnd, tone, wrapUp = false }) {
  const lines = [];
  if (first) lines.push(t(friendly(tone) ? 'debate_mod_intro_friends' : 'debate_mod_intro'), t('debate_topic_label'), neutraliseQuoted(String(topic || '').slice(0, DEBATE_TOPIC_MAX)));
  // Numbered (plan §14.2): the moderator names the next speaker by NUMBER — free-text names were
  // ambiguous four review rounds in a row. The number is the position in `names`.
  lines.push(t('debate_mod_cast', names.map((n, i) => `${i + 1} ${n}`).join(', ')));
  lines.push(t('debate_turn_head'));
  if (delta.items.length) lines.push(renderItems(delta.items, t));
  if (delta.omitted) lines.push(t('debate_omitted', delta.omitted));
  // Right after the opening nobody spoke last — the 「you may not pick X」 clause is left out then.
  const taskKey = friendly(tone) ? 'debate_mod_task_friends' : 'debate_mod_task';
  lines.push(lastName ? t(taskKey, lastName) : t(`${taskKey}_open`));
  lines.push(t('debate_call_full_name'));
  const style = styleLine(tone, t, true);
  if (style) lines.push(style);
  // The last send of the budget: the moderator closes the debate (plan §15.1 ③).
  if (wrapUp) lines.push(t('debate_mod_wrapup'));
  // The control line instruction is ALWAYS the last thing the moderator reads, whatever the tone (§12.1 ①②).
  lines.push(canEnd || wrapUp ? t('debate_mod_control') : t('debate_mod_control_no_end'));
  return lines.join('\n');
}

// ── the moderator's control line ──
// Only the LAST non-empty line counts: a NEXT inside the body may be a quote of someone else.
// The Korean forms (다음: / 끝 / 종료) are written as escapes — the i18n guard keeps Hangul out of code.
const CONTROL_NEXT_RE = /^\s*[*_`]*\s*(?:NEXT|\uB2E4\uC74C)\s*[:：]\s*(.+?)\s*[*_`]*\s*$/i;
const CONTROL_END_RE = /^\s*[*_`]*\s*(?:END|\uB05D|\uC885\uB8CC)\s*[.!]?\s*[*_`]*\s*$/i;
/**
 * `{ body, control }` of a moderator reply: `control` = `{ kind: 'next', name }` | `{ kind: 'end' }`
 * | null, `body` = the text without the control line (what the timeline shows and the debaters get).
 */
export function splitControl(text) {
  const lines = String(text || '').split('\n');
  let i = lines.length - 1;
  while (i >= 0 && !lines[i].trim()) i--;
  if (i < 0) return { body: '', control: null };
  const last = lines[i];
  let control = null;
  const next = CONTROL_NEXT_RE.exec(last);
  if (next) control = { kind: 'next', name: next[1] };
  else if (CONTROL_END_RE.test(last)) control = { kind: 'end' };
  if (!control) return { body: String(text || '').replace(/\s+$/, ''), control: null };
  return { body: lines.slice(0, i).join('\n').replace(/\s+$/, ''), control };
}

/**
 * The candidate a free-text `name` means: `candidates` = `[{ id, names: [string] }]` (alias, the
 * page label, the model label). Exact key match on any name wins; otherwise a containment match
 * (either way) — but only when it points at exactly ONE candidate. null = nobody / ambiguous.
 */
/** A name as a person reads it: NFKC, whitespace collapsed, case-folded — brackets and punctuation KEPT (unlike nameKey). */
const normName = (x) => String(x == null ? '' : x).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
export function matchSpeaker(name, candidates) {
  // Brackets mean two different things in a NEXT line: the meta a moderator echoes from a header
  // (`플래시 토끼 (Gemini 3.6 Flash · 경량형 · 4초 걸림)`) and the page label's own model
  // (`Claude (Opus 5)`). Aliases cannot hold brackets (DEBATE_ALIAS_BAD_RE). So the name with the
  // bracketed tail dropped is tried FIRST — an alias followed by echoed meta resolves to that alias
  // and can never merge into another alias's key (Codex meta 2R blocker) — and only when that names
  // nobody (or is ambiguous) is the whole string tried, which is how a page label with its own
  // brackets still resolves (Codex meta 3R blocker).
  const raw = String(name == null ? '' : name);
  // 0) The string as written, whitespace / case aside, IS one candidate's name (a page label with its
  //    own brackets, `Claude (Opus 5)`) — that is the most specific reading (Codex meta 4R blocker).
  const exact = candidates.filter((c) => c.names.some((n) => normName(n) === normName(raw)));
  if (exact.length === 1) return exact[0].id;
  const stripped = raw.replace(/\s*[(（\[].*$/, '');
  const first = matchSpeakerKey(nameKey(stripped), candidates);
  if (first || stripped === raw) return first;
  return matchSpeakerKey(nameKey(raw), candidates);
}
function matchSpeakerKey(k, candidates) {
  if (!k) return null;
  const exact = candidates.filter((c) => c.names.some((n) => nameKey(n) === k));
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1) return null;
  const loose = candidates.filter((c) => c.names.some((n) => { const nk = nameKey(n); return nk && (nk.includes(k) || k.includes(nk)); }));
  return loose.length === 1 ? loose[0].id : null;
}

/**
 * The debater a user message addresses with `@name`, or null. `candidates` = `[{ id, names, words? }]`.
 * Names may hold spaces, so every candidate name is looked for right after an `@` (key comparison
 * over the following characters); at one `@` the longest name wins. Failing a name, a FAMILY WORD
 * (`@opus`, `@오퍼스야`) counts only when it follows the `@` exactly, is not continued by an ASCII
 * letter / digit (`@professional` is not `@pro`), and belongs to exactly ONE candidate (plan §11.4 ③).
 * With several `@`s the LAST one that names someone wins — the same 「the latest mention」 rule the
 * queue applies across messages (Codex 1R 후속).
 */
export function mentionOf(text, candidates) {
  const s = String(text || '');
  let found = null;
  for (let at = s.indexOf('@'); at >= 0; at = s.indexOf('@', at + 1)) {
    const rest = s.slice(at + 1, at + 1 + DEBATE_ALIAS_MAX * 2);
    const tail = nameKey(rest);
    let best = null;
    for (const c of candidates) {
      for (const n of c.names) {
        const nk = nameKey(n);
        if (nk && tail.startsWith(nk) && (!best || nk.length > best.len)) best = { id: c.id, len: nk.length };
      }
    }
    if (!best) {
      const lower = rest.toLowerCase();
      const owners = candidates.filter((c) => (c.words || []).some((w) => {
        const wl = String(w).toLowerCase();
        return wl && lower.startsWith(wl) && !/^[a-z0-9]/i.test(rest.slice(wl.length));
      }));
      if (owners.length === 1) best = { id: owners[0].id };
    }
    if (best) found = best.id;
  }
  return found;
}

/**
 * The rule-based next debater (자동 순서, and the fallback for every refused moderator choice): the
 * eligible debater who has gone longest without speaking, never `prev`; ties go to speaking order.
 * `lastSpoke` = Map id → seq of its last turn (absent = never). null when nobody is eligible.
 */
export function autoNext({ order, eligible, prev, lastSpoke }) {
  let best = null;
  for (const id of order) {
    if (!eligible.has(id) || id === prev) continue;
    const at = lastSpoke.has(id) ? lastSpoke.get(id) : -Infinity;
    if (!best || at < best.at) best = { id, at };
  }
  if (best) return best.id;
  // Only `prev` is left: a debate of one is still a turn (the page pauses below two debaters anyway).
  return eligible.has(prev) ? prev : null;
}

/**
 * May the moderator END the debate now? Only after `minTurns` debater turns, and never while the user
 * has words waiting in the queue — ending then would strand them undelivered (Codex 1R blocker:
 * the user typed while the moderator was answering, the moderator said END, the words never went).
 */
export function moderatorMayEnd({ turnsUsed, minTurns, queued }) {
  return turnsUsed >= minTurns && !queued;
}

/**
 * What the budget allows next (plan §15.1 ①③): 'stop' when nothing is left, 'wrapup' when ONE send
 * is left and an AI moderator can use it to close the debate (not when the user just named someone —
 * their pick is honoured), 'go' otherwise.
 */
export function budgetStep({ used, budget, aiModerator, wrapUpDone, forced }) {
  const left = budget - used;
  if (left <= 0) return 'stop';
  if (left === 1 && aiModerator && !wrapUpDone && !forced) return 'wrapup';
  return 'go';
}
/** The tab has been hidden long enough that the next send should wait for the user (plan §15.1 ②). */
export function hiddenTooLong({ hidden, since, now, limit }) {
  return !!hidden && Number.isFinite(since) && now - since >= limit;
}

/**
 * The next debater after a moderator reply: its NEXT name when that is a real, eligible debater
 * other than `prev`; otherwise the rule (`fallback: true`). `end` when it said END and ending is allowed.
 */
export function chooseAfterModerator({ control, candidates, order, eligible, prev, lastSpoke, canEnd, numbered = null }) {
  if (control && control.kind === 'end' && canEnd) return { end: true, id: null, fallback: false };
  if (control && control.kind === 'next') {
    // Resolution order (plan §14.2, Codex meta 5R): each step either DECIDES or passes on — a step
    // that recognised its form never hands a failure to the next (that is how `12 플래시 토끼` became
    // a name and a dropped 「3호기」 became number 3).
    //  1) the string is exactly a debater's name (whitespace / case aside), looked up among ALL of
    //     them, dropped ones too — that person, or the rule when they cannot speak;
    //  2) it starts with a number — the position in `numbered` (the order that moderator call was
    //     shown: `2`, `2번`, `#2`, `2 이름`), or the rule when the number points nowhere usable;
    //  3) otherwise a name (matchSpeaker over the debaters who can speak).
    const text = String(control.name || '');
    const usable = (id) => !!id && id !== prev && eligible.has(id);
    const exact = candidates.filter((c) => c.names.some((n) => normName(n) === normName(text)));
    let id = null;
    let decided = false;
    if (exact.length === 1) { id = exact[0].id; decided = true; }
    else {
      const num = /^\s*#?(\d+)/.exec(text); // ANY length — `123 이름` is a number too (Codex meta 6R)
      if (num) { id = Array.isArray(numbered) ? numbered[Number(num[1]) - 1] || null : null; decided = true; }
    }
    if (!decided) id = matchSpeaker(text, candidates.filter((c) => eligible.has(c.id)));
    if (usable(id)) return { end: false, id, fallback: false };
  }
  return { end: false, id: autoNext({ order, eligible, prev, lastSpoke }), fallback: true };
}

// ── history (#1769 후속: a stored debate opens as the debate, not as columns) ──
// A debate session's history entry carries a RECORD beside its columns: the cast, the setup
// choices, and the transcript's skeleton — which column spoke in which round (the words themselves
// stay in the column turns, once), plus the user's own words, which exist nowhere else (a debate
// prompt is the page's composition, not what the user typed). `dl` / `prev` / `fr` / `el` are the
// orchestrator's cursors, so a reloaded debate that resumes tells each speaker only what it has not
// received yet.
export const DEBATE_RECORD_LOG_MAX = 400;
const plainObj = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const nonNegInt = (v) => Number.isInteger(v) && v >= 0;
/**
 * A stored record, validated against the entry's column ids: the normalised record, `undefined`
 * when it is malformed (history.js then drops the whole entry — a record is never repaired), null
 * when `raw` is null. Unknown fields are ignored (a later version may add some).
 */
export function readDebateRecord(raw, colIds, textMax) {
  if (raw === null) return null;
  if (!plainObj(raw)) return undefined;
  const inPage = (id) => typeof id === 'string' && colIds.includes(id);
  const idList = (a, within) => (Array.isArray(a) && a.every((id) => within(id)) && new Set(a).size === a.length ? a.slice() : undefined);
  const debaters = idList(raw.debaters, inPage);
  if (!debaters || debaters.length < 2) return undefined;
  const modCol = raw.modCol == null ? null : (inPage(raw.modCol) && !debaters.includes(raw.modCol) ? raw.modCol : undefined);
  if (modCol === undefined || !MODERATOR_KINDS.includes(raw.modKind) || (raw.modKind === MOD_AI && !modCol)) return undefined;
  const cast = [...debaters, ...(modCol ? [modCol] : [])];
  const inCast = (id) => cast.includes(id);
  const isDebater = (id) => debaters.includes(id);
  if (!STANCES.includes(raw.stance) || !plainObj(raw.tone) || typeof raw.tone.kind !== 'string' || (raw.tone.custom !== undefined && typeof raw.tone.custom !== 'string')) return undefined;
  if (!plainObj(raw.aliases) || !plainObj(raw.dl) || !Array.isArray(raw.log) || raw.log.length > DEBATE_RECORD_LOG_MAX) return undefined;
  const aliases = {};
  for (const [id, v] of Object.entries(raw.aliases)) {
    if (!inCast(id) || typeof v !== 'string' || !cleanAlias(v) || aliasProblem(v)) return undefined;
    aliases[id] = cleanAlias(v);
  }
  const dl = {};
  for (const [id, v] of Object.entries(raw.dl)) { if (!inCast(id) || !nonNegInt(v)) return undefined; dl[id] = v; }
  const log = [];
  let lastQ = 0;
  for (const e of raw.log) {
    if (!plainObj(e) || !Number.isInteger(e.q) || e.q <= lastQ) return undefined; // seqs strictly increase
    lastQ = e.q;
    if (e.u !== undefined) {
      if (typeof e.u !== 'string' || e.c !== undefined) return undefined;
      log.push({ q: e.q, u: e.u.slice(0, textMax) });
      continue;
    }
    if (!inCast(e.c) || !Number.isInteger(e.r)) return undefined;
    for (const k of ['mod', 'o']) if (e[k] !== undefined && typeof e[k] !== 'boolean') return undefined;
    if ((e.tk !== undefined && !TIER_KEYS.includes(e.tk)) || (e.s !== undefined && !(Number.isFinite(e.s) && e.s >= 0))) return undefined;
    // A moderator line is the moderator column's; a debater's is a debater's (the flag decides how the text is read).
    if ((e.mod === true) !== (e.c === modCol)) return undefined;
    log.push({ q: e.q, c: e.c, r: e.r, ...(e.mod ? { mod: true } : {}), ...(e.o ? { o: true } : {}), ...(e.tk ? { tk: e.tk } : {}), ...(e.s !== undefined ? { s: e.s } : {}) });
  }
  const prev = raw.prev == null ? null : (isDebater(raw.prev) ? raw.prev : undefined);
  const fr = idList(raw.fr === undefined ? [] : raw.fr, isDebater);
  const el = idList(raw.el === undefined ? debaters : raw.el, isDebater);
  const turns = raw.turns === undefined ? 0 : raw.turns;
  for (const k of ['modStarted', 'done', 'legacy']) if (raw[k] !== undefined && typeof raw[k] !== 'boolean') return undefined;
  if (prev === undefined || !fr || !el || !nonNegInt(turns)) return undefined;
  const tone = normalizeTone(raw.tone.kind, raw.tone.custom || '');
  return { debaters, modCol, modKind: raw.modKind, stance: raw.stance, tone, aliases, log, dl, prev, fr, el, turns, modStarted: raw.modStarted === true, done: raw.done === true, ...(raw.legacy === true ? { legacy: true } : {}) };
}
/**
 * The log cut to `max` entries for the record, oldest first — but never a line some speaker has
 * not received yet (seq above the lowest cursor in `delivered`, a Map or object colId → seq): a
 * user message dropped there would never reach anyone after a reload. Only when those alone
 * exceed `max` are the oldest of them cut too (the bound is what keeps the entry readable).
 */
export function trimRecordLog(log, delivered, max) {
  if (log.length <= max) return log.slice();
  const cursors = [...(delivered instanceof Map ? delivered.values() : Object.values(delivered || {}))];
  const floor = cursors.length ? Math.min(...cursors) : 0;
  const owed = log.filter((e) => e.q > floor);
  if (owed.length >= max) return owed.slice(-max);
  const older = log.filter((e) => e.q <= floor);
  return [...older.slice(older.length - (max - owed.length)), ...owed];
}
/**
 * A record DERIVED from the turns of an entry written before records existed (every debate turn is
 * `kind: 'debate'`): the debaters are the columns that answered the first round (the opening), a
 * single other debating column is the AI moderator, and the order is the rounds'. What was never
 * stored cannot be derived — the user's own mid-debate words, the stances, the tone, the aliases —
 * so those take their defaults (`legacy: true`; the page names the cast with today's aliases).
 * null when the entry is not a debate. `columns` = the normalised entry's columns.
 */
export function legacyDebateRecord(columns, firstRound) {
  const order = Object.keys(columns);
  const said = [];
  for (const id of order) {
    for (const turn of columns[id].turns || []) {
      if (turn.role !== 'assistant' || turn.kind !== TURN_KIND_DEBATE || !Number.isInteger(turn.round)) continue;
      said.push({ c: id, r: turn.round, ok: !!String(turn.text || '').trim() && !turn.errorText });
    }
  }
  if (!said.length) return null;
  const open = Number.isInteger(firstRound) ? firstRound : Math.min(...said.map((a) => a.r));
  let debaters = order.filter((id) => said.some((a) => a.c === id && a.r === open));
  let modCol = null;
  if (debaters.length >= 2) {
    const others = order.filter((id) => !debaters.includes(id) && said.some((a) => a.c === id));
    if (others.length === 1) modCol = others[0];
  } else {
    // The opening is gone (evicted by the history bound): every column that spoke debated, except
    // one whose every answered turn ends in a control line — that one moderated. Ambiguous = no moderator.
    const speakers = order.filter((id) => said.some((a) => a.c === id));
    const mods = speakers.filter((id) => {
      const answered = (columns[id].turns || []).filter((x) => x.role === 'assistant' && x.kind === TURN_KIND_DEBATE && String(x.text || '').trim() && !x.errorText);
      return answered.length > 0 && answered.every((x) => splitControl(x.text).control);
    });
    if (mods.length === 1) modCol = mods[0]; // too few debaters left beside it → null below (the columns view), never a moderator shown as a debater
    debaters = speakers.filter((id) => id !== modCol);
  }
  if (debaters.length < 2) return null;
  said.sort((a, b) => a.r - b.r || order.indexOf(a.c) - order.indexOf(b.c));
  const log = [];
  const dl = {};
  const fr = new Set();
  let prev = null;
  let turns = 0;
  let modStarted = false;
  for (const a of said) {
    const isMod = a.c === modCol;
    if (!isMod && !debaters.includes(a.c)) continue;
    const q = log.length + 1;
    log.push({ q, c: a.c, r: a.r, ...(isMod ? { mod: true } : {}), ...(a.r === open ? { o: true } : {}) });
    // Received = everything before its own answered turn (the opening: nobody yet).
    if (a.ok) dl[a.c] = a.r === open ? 0 : q - 1;
    if (isMod) { if (a.ok) modStarted = true; continue; }
    if (a.r === open) continue;
    turns += 1;
    prev = a.c;
    if (a.ok) fr.add(a.c);
  }
  return { debaters, modCol, modKind: modCol ? MOD_AI : MOD_AUTO, stance: STANCE_NONE, tone: normalizeTone(TONE_FRIENDS, ''), aliases: {}, log, dl, prev, fr: [...fr], el: debaters.slice(), turns, modStarted, done: false, legacy: true };
}
/**
 * The transcript a record describes, its words read back from the turns: `lookup(colId, round)` =
 * that turn's text when it answered, '' when it failed, null when the turn is gone (evicted by the
 * history bound). A moderator's words lose their control line, as they did live. Entries keep
 * their stored seq — `dl` points at them. `lastSpoke` = each debater's last answered seq.
 */
export function transcriptFromRecord(record, lookup) {
  const transcript = [];
  const lastSpoke = new Map();
  for (const e of record.log) {
    if (e.u !== undefined) { transcript.push({ seq: e.q, speaker: SPEAKER_USER, role: ROLE_USER, text: e.u }); continue; }
    const raw = lookup(e.c, e.r);
    const text = raw ? (e.mod ? splitControl(raw).body : String(raw)) : '';
    transcript.push({ seq: e.q, speaker: e.c, role: e.mod ? ROLE_MODERATOR : ROLE_PARTICIPANT, text, round: e.r, ...(e.o ? { opening: true } : {}), ...(e.tk ? { tierKey: e.tk } : {}), ...(e.s !== undefined ? { secs: e.s } : {}) });
    if (!e.mod && text.trim()) lastSpoke.set(e.c, e.q);
  }
  return { transcript, lastSpoke };
}
