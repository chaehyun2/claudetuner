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

import { neutraliseQuoted, mdInlineText } from './helpers.js';
import { CLAUDE_FAST_MODEL, CLAUDE_SONNET_MODEL, isPaidClaudePlan } from '../../vendor-ai/models.js';
import { TURN_KIND_DEBATE, COMPARE_PROVIDERS, colIdOf, DEBATE_BALANCED_MIN_TURNS, DEBATE_MAX_ASKS, DEBATE_BUDGET_CONTINUE } from './constants.js';
import { usagePeak } from './usage-floor.js';

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
// #1856 ③: a ROLE rather than a personality — research: among mixed-model debates the less agreeable
// role scores best. The last debater asks for sources behind factual claims and checks them itself.
export const STANCE_VERIFY = 'verify';
// Positions and roles are two settings (2026-09-29 user request: 「자유 토론에서도 반론·검증 담당을 따로
// 고를 수 있어야」): a BASE — free or for/against — plus any of the ROLES, each given to one debater.
// A run carries them as ONE value (records, the finish statistics, GA): the base, or the roles joined by
// '+' after it — the single values of before keep their meaning ('devil' = free + contrarian). For/against
// has no contrarian (half the table already argues against), so 'procon+devil' does not exist.
export const STANCE_BASES = [STANCE_NONE, STANCE_PRO_CON];
export const STANCE_ROLES = [STANCE_DEVIL, STANCE_VERIFY];
export const STANCE_DEVIL_VERIFY = 'devil+verify';
export const STANCE_PRO_CON_VERIFY = 'procon+verify';
export const STANCES = [STANCE_NONE, STANCE_PRO_CON, STANCE_DEVIL, STANCE_VERIFY, STANCE_DEVIL_VERIFY, STANCE_PRO_CON_VERIFY];
/** May `role` go with `base`? The contrarian only in a free debate. */
export const roleAllowed = (base, role) => STANCE_ROLES.includes(role) && !(base === STANCE_PRO_CON && role === STANCE_DEVIL);
/** A base + roles → the run's one stance value (unknown / disallowed roles dropped, the order fixed). */
export function composeStance(base, roles) {
  const b = STANCE_BASES.includes(base) ? base : STANCE_NONE;
  const rs = STANCE_ROLES.filter((r) => Array.isArray(roles) && roles.includes(r) && roleAllowed(b, r));
  if (!rs.length) return b;
  return b === STANCE_NONE ? rs.join('+') : [b, ...rs].join('+');
}
/**
 * The run's stance as a history record stores it: the verifier as `vf: true` beside a value a 1.42–1.46
 * reader knows (none / procon / devil — it refuses others and drops the entry). readDebateRecord undoes it.
 */
export function recordStance(stance) {
  const { base, roles } = splitStance(stance);
  const kept = base === STANCE_NONE && roles.includes(STANCE_DEVIL) ? STANCE_DEVIL : base;
  return roles.includes(STANCE_VERIFY) ? { stance: kept, vf: true } : { stance: kept };
}
/**
 * The pace as a history record stores it (batch review 1.47.0): 「충분히」 is written as `deep` + `pb: true` —
 * a 1.46 reader refuses an unknown pace, drops the entry and removes it on its next write (a rollback would
 * lose every default-pace debate). It reads the run as 「깊게」; readDebateRecord undoes it.
 */
export function recordPace(pace) {
  return pace === PACE_BALANCED ? { pace: PACE_DEEP, pb: true } : { pace };
}
/** The run's stance value → `{ base, roles }` (an unknown value reads as a free debate). */
export function splitStance(stance) {
  const v = STANCES.includes(stance) ? stance : STANCE_NONE;
  const parts = v.split('+');
  const base = parts[0] === STANCE_PRO_CON ? STANCE_PRO_CON : STANCE_NONE;
  return { base, roles: STANCE_ROLES.filter((r) => parts.includes(r)) };
}
// Tone (plan §12): how the AIs talk — like close friends (the default, 2026-09-26 user request),
// the calm debate wording of phases 1–2, or the user's own style line. Only the TASK sentences change
// with the tone; the quoting rule, identity / stance lines and the moderator's control line never do.
export const TONE_FRIENDS = 'friends';
export const TONE_CALM = 'calm';
export const TONE_CUSTOM = 'custom';
export const TONES = [TONE_FRIENDS, TONE_CALM, TONE_CUSTOM];
export const DEBATE_TONE_MAX = 300;
// Pace (#1843, user request 2026-09-27): 「깊게 파고들기」 — the AI moderator opens a new angle every
// turn and ends only when the user asks; 「빠르게 결론」 — the earlier behaviour (it may end once no new
// point comes up). 「충분히 논의 후 결론」 (balanced, the default since 2026-09-29 — user request: the two
// were far apart, ~8.5 turns vs. a debate only the user could end) raises new angles like 「깊게」, and
// past DEBATE_BALANCED_MIN_TURNS may conclude on its own once what is left would not change the answer.
// Only an AI moderator reads it; the other kinds never end by themselves. PACES is the panel's order.
export const PACE_DEEP = 'deep';
export const PACE_BALANCED = 'balanced';
export const PACE_QUICK = 'quick';
export const PACES = [PACE_DEEP, PACE_BALANCED, PACE_QUICK];
export const PACE_DEFAULT = PACE_BALANCED;
// Without an AI moderator nobody ENDS a debate (#1909: a shared 「자동 순서」 debate ran 100 turns and the
// user's 「결론 내봐」 changed nothing). Under 「자동 순서」 the pace is a TURN COUNT per leg (from the
// start, a restore or the last conclusion): at it a debater writes the conclusion (pickConcluder) and the
// run stops. 「깊게」 has none — it ends on 「🏁 결론 내기」 or the send limit, like an AI moderator's.
const AUTO_WRAP_TURNS = { [PACE_QUICK]: 6, [PACE_BALANCED]: DEBATE_BALANCED_MIN_TURNS };
/** The automatic-order turn count of a pace, or null (「깊게」 — no automatic conclusion). */
export const autoWrapTurns = (pace) => (Number.isInteger(AUTO_WRAP_TURNS[pace]) ? AUTO_WRAP_TURNS[pace] : null);
/** Has an automatic-order leg run long enough for its conclusion? `legTurns` = debater turns since the leg began. */
export function autoWrapDue({ pace, modKind, legTurns }) {
  const limit = AUTO_WRAP_TURNS[pace];
  return modKind === MOD_AUTO && Number.isInteger(limit) && legTurns >= limit;
}
// Reply length (#1862, user request 2026-09-28): how much ONE turn says — independent of the pace (how
// many turns). A flat cap ended many turns too short, a loose one made every turn long: the setting is
// the base, a turn with evidence may go to twice it, and the moderator can grant a longer turn (LONG).
export const LENGTH_SHORT = 'short';
export const LENGTH_NORMAL = 'normal';
export const LENGTH_LONG = 'long';
export const LENGTHS = [LENGTH_SHORT, LENGTH_NORMAL, LENGTH_LONG];
// A user's 「자세히」 is read by the debater itself (#1862, after 5R): the length line says a turn may
// double when the user asked for detail. A pattern list could not tell 「자세히 설명해 주지 마」 from
// 「자세히 분석해 줘 예시는 필요 없어」 — every review round found a new counterexample. The moderator's
// LONG stays the page's own, certain grant (numbered, parsed).
const lengthOf = (x) => (LENGTHS.includes(x) ? x : LENGTH_NORMAL);
/** 「길이: …」 for a debater's opening / turn, by the reply-length setting and the tone. */
function debaterLengthLine(t, role, length, tone) {
  return t('debate_len_line', t(`debate_len_${role}_${lengthOf(length)}_${friendly(tone) ? 'friends' : 'calm'}`));
}
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
export const SETTING_ROLES = 'roles';
export const SETTING_TONE = 'tone';
export const SETTING_PACE = 'pace';
export const SETTING_LENGTH = 'length';
// #1971 §3.3: the background-run options — off the default when turned off / set to keep going.
export const SETTING_AWAY = 'away';
export const SETTING_BUDGET = 'budget';
export const SETTING_NOTIFY = 'notify';
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
  if (Array.isArray(p.roles) && p.roles.some((r) => roleAllowed(p.stance || STANCE_NONE, r))) out.push(SETTING_ROLES);
  if ((p.tone || TONE_FRIENDS) !== TONE_FRIENDS) out.push(SETTING_TONE);
  if ((p.pace || PACE_DEFAULT) !== PACE_DEFAULT) out.push(SETTING_PACE);
  if ((p.length || LENGTH_NORMAL) !== LENGTH_NORMAL) out.push(SETTING_LENGTH);
  if (p.awayPause === false) out.push(SETTING_AWAY);
  if (p.budgetMode === DEBATE_BUDGET_CONTINUE) out.push(SETTING_BUDGET);
  if (p.notify === false) out.push(SETTING_NOTIFY);
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
// `NEXT:` line). Its service: a paid plan first, then this order (user decision, 2026-09-27) — both after
// the usage left (moderatorOrder, #2082).
export const MODERATOR_RANK = ['chatgpt', 'claude', 'gemini'];
// Claude's moderator model by plan — asked for explicitly, so it is its own column beside the Claude
// debater's `claude:auto`. Paid: Sonnet 5.5 — vendor-ai's FAST_MODEL since v0.22.0 (claude.ai's
// newest Sonnet, read off its bootstrap 2026-09-29; was Sonnet 5). Auto resolves to the same model on
// a paid plan; on a measured Free plan Auto is Sonnet 5 (vendor-ai v0.25.0 — Sonnet 5.5 was measured
// ~5x slower to first text on Free, 2026-09-30). The Free moderator stays on Sonnet 4.6 (free-tier in
// claude.ai's gate, fast) so the moderator and the Free debater are different models and read as
// different voices. Both are the package's names (#2067), so a vendor bump moves them with it:
// PAID = CLAUDE_FAST_MODEL, FREE = CLAUDE_SONNET_MODEL (the end of the package's Auto fallback chain).
export const CLAUDE_MODERATOR_PAID = CLAUDE_FAST_MODEL;
export const CLAUDE_MODERATOR_FREE = CLAUDE_SONNET_MODEL;
// ── plan tier (#2054 D): 'paid' · 'free' · 'unknown' from a status plan LABEL (status.providers[p].plan) ──
// Until #2054 anything but 「Free」 was paid, so Claude's `API` / `unknown` and a ChatGPT / Gemini label no
// rule knows took the paid moderator model and the paid tint. Now a label is paid only when it names a
// known paid plan; whatever cannot be told is 'unknown' — never paid.
// Claude: the label is the collector's display of vendor-ai claudeOrgPlan (bg/plan-label.js CLAUDE_PLAN_LABELS,
// refined by a seat tier: `Team Premium`, `Max (<tier>)`) — read back to that key and judged by the package's
// isPaidClaudePlan, the same rule the client gates models by.
const CLAUDE_LABEL_KEYS = [[/^max 20x$/, 'max_20x'], [/^max 5x$/, 'max_5x'], [/^max( \(.+\))?$/, 'max'], [/^pro$/, 'pro'], [/^team( (premium|standard|tier 2))?$/, 'team'], [/^enterprise$/, 'enterprise'], [/^free$/, 'free'], [/^api$/, 'api']];
// ChatGPT (bg/parse-chatgpt.js CHATGPT_PLAN_NAMES, ui/util.js planDisplayName) and Gemini (bg/gemini-plan-labels.js)
// paid labels, lower-cased, matched WHOLE (Codex 1R: a prefix let 「Team Mystery」 / 「AI Pro 999x」 read as paid).
// An unrecognised code reaches the label capitalised — 'unknown' here.
const PAID_LABELS = {
  chatgpt: /^(go|plus|pro (5x|20x|25x|100|200|500)|team|business|enterprise|education( \(k-12\))?)$/,
  gemini: /^(ai (plus|pro|ultra( (5|20)x)?)|advanced|work)$/,
};
/** The Claude plan key (vendor-ai claudeOrgPlan's vocabulary) of a display label, or 'unknown'. */
function claudePlanKey(label) {
  const hit = CLAUDE_LABEL_KEYS.find(([re]) => re.test(label));
  return hit ? hit[1] : 'unknown';
}
/** `'paid'` · `'free'` · `'unknown'` for a provider's plan label (null / blank / unrecognised = 'unknown'). */
export function planTier(provider, label) {
  const l = typeof label === 'string' ? label.trim().toLowerCase() : '';
  if (!l) return 'unknown';
  if (l === 'free') return 'free';
  if (provider === 'claude') return isPaidClaudePlan(claudePlanKey(l)) ? 'paid' : 'unknown';
  return PAID_LABELS[provider] && PAID_LABELS[provider].test(l) ? 'paid' : 'unknown';
}
/** A plan label is a known paid plan (planTier) — the moderator seat's 「paid first」. */
export const isPaidPlan = (label, provider) => planTier(provider, label) === 'paid';
// ── the moderator's usage (#2082) ──
// The moderator answers after every debater turn: in one all-Free debate (2026-10-04) it was 26 of the
// Gemini Free account's 40 requests (~3x a debater), and Gemini's 5h window went 0 → 100% in ~50 min while
// the other two showed nothing. So WHEN a moderator is picked (never during a run — a debate keeps the
// moderator it started with) the services are ordered by the room they have left, in two classes:
//   roomy — a live usage peak below MOD_BUSY_PCT, or NOTHING known: Claude Free has published no usage since
//           2026-08-21, and a service without a snapshot says nothing. Unknown reads as 「not exhausted」, the
//           same reading as usage-floor.js (never a decision on a guess) — it keeps its plan / rank place;
//   busy  — a live window at or past MOD_BUSY_PCT (any plan): last, the lowest peak first.
// Within a class the 2026-09-27 rule is unchanged: a paid plan first, then MODERATOR_RANK. Gemini Free — the
// smallest window (0.25x, metered by throughput: ~2.5%p per moderator call measured) — is therefore already
// the last roomy choice: Gemini is last in the rank and a Free plan never outranks a paid one. A service is
// only REORDERED, never dropped — when it is the only one that can moderate, it still does.
export const MOD_BUSY_PCT = 70;
const busyPeak = (peak) => peak !== null && peak >= MOD_BUSY_PCT;
// The service whose Free plan has the smallest window (above) — a seat on it is 「crowded」 even when roomy (#2089).
const SMALL_WINDOW_PROVIDER = 'gemini';
/**
 * MODERATOR_RANK re-ordered for picking a moderator from the status (`providers[p]` = { plan, usage }):
 * roomy before busy, busy by the lower peak, then paid first, then the rank. `usage: false` leaves usage out
 * (the plan / rank order alone — what the pick was before #2082).
 */
export function moderatorOrder(providers, { now = Date.now(), usage = true } = {}) {
  const ps = providers || {};
  const keyed = MODERATOR_RANK.map((p, rank) => {
    const s = ps[p] || {};
    const peak = usage ? usagePeak(s.usage, { now }) : null;
    return { p, rank, busy: busyPeak(peak), peak, paid: isPaidPlan(s.plan, p) ? 1 : 0 };
  });
  keyed.sort((a, b) => a.busy - b.busy || (a.busy && b.busy ? a.peak - b.peak : 0) || b.paid - a.paid || a.rank - b.rank);
  return keyed.map((k) => k.p);
}
const catalogIds = (list) => (Array.isArray(list) ? list.filter((m) => m && typeof m === 'object' && m.id != null && m.id !== '').map((m) => ({ id: String(m.id), label: String(m.label || ''), default: m.default === true, role: typeof m.role === 'string' ? m.role : null })) : []);
/**
 * Where the default moderator sits, from the status (`providers[p]` = { loggedIn, permitted, plan },
 * `catalogs[p]` = the model list): `{ provider, model, debaterModel }` — `model` is always an
 * explicit id (an `auto` column takes the stored model seed, which may be a slow one — plan §18.9 ②);
 * `debaterModel` = the model the SAME service's debater then uses instead of Auto (ChatGPT on a catalog
 * whose default IS the Instant the moderator takes: its debater moves to Thinking), else null.
 * Null when no signed-in service offers a moderator model. The services are tried in moderatorOrder —
 * the usage left first (#2082), then paid, then the rank; `now` = the clock the usage windows are read by.
 */
export function pickModeratorSeat({ providers, catalogs, now = Date.now() }) {
  const ps = providers || {};
  const ready = (p) => ps[p] && ps[p].loggedIn === true && ps[p].permitted === true;
  const seat = seatFrom(moderatorOrder(ps, { now }).filter(ready), ps, catalogs || {});
  if (!seat) return null;
  // `passed` (#2082): the service the plan / rank order alone would have seated, when usage moved the seat
  // past it — the ⚙ panel says why another AI moderates. Absent when usage changed nothing.
  const plain = seatFrom(moderatorOrder(ps, { usage: false }).filter(ready), ps, catalogs || {});
  return plain && plain.provider !== seat.provider ? { ...seat, passed: plain.provider } : seat;
}
/** The first service of `order` whose catalog offers its moderator model (pickModeratorSeat), or null. */
function seatFrom(order, ps, cats) {
  for (const p of order) {
    const list = catalogIds(cats[p]);
    const tierOfRow = (m) => defaultAliasOf(p, m.id, m.label, m.role);
    if (p === 'claude') {
      const want = isPaidPlan(ps[p].plan, p) ? CLAUDE_MODERATOR_PAID : CLAUDE_MODERATOR_FREE;
      if (list.some((m) => m.id === want)) return { provider: p, model: want, debaterModel: null };
    } else if (p === 'gemini') {
      const flash = list.find((m) => tierOfRow(m).family === 'debate_family_flash');
      if (flash) return { provider: p, model: flash.id, debaterModel: null };
    } else if (p === 'chatgpt') {
      // The moderator is the fast Instant row. Its debater: Auto when the default is the Auto row (vendor-ai
      // v0.23.0 — the site's own default slug, a model of its own, family-less); when the default IS that
      // Instant (before v0.23.0, and whenever the site names no Auto) Auto would be the moderator's model
      // twice, so the debater takes the first Thinking row. Any other default: skipped, as before.
      const def = list.find((m) => m.default);
      const fast = list.find((m) => tierOfRow(m).family === 'debate_family_instant');
      const think = list.find((m) => tierOfRow(m).tier === TIER_REASONING);
      if (def && fast && def.id === fast.id && think) return { provider: p, model: fast.id, debaterModel: think.id };
      if (def && fast && def.id !== fast.id && tierOfRow(def).family === null) return { provider: p, model: fast.id, debaterModel: null };
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
  if (ids.includes(seat)) return { ids, seat: null };
  return pick.passed ? { ids: [...ids, seat], seat, passed: pick.passed } : { ids: [...ids, seat], seat };
}
/**
 * #2089: a STORED layout's seat keeps its column and moderates as saved (§18.9 ① — nothing is moved for usage).
 * When its service is busy (≥ MOD_BUSY_PCT) or on the smallest window (Gemini Free), the ⚙ only suggests another
 * moderator: this returns that service — but only when another service among `targets` comes before it in
 * moderatorOrder (else there is nothing better to switch to). Null otherwise.
 */
export function seatCrowded(seat, targets, providers, { now = Date.now() } = {}) {
  if (!seat) return null;
  const provOf = (id) => String(id).split(':')[0];
  const p = provOf(seat);
  const s = (providers || {})[p] || {};
  if (!busyPeak(usagePeak(s.usage, { now })) && !(p === SMALL_WINDOW_PROVIDER && planTier(p, s.plan) === 'free')) return null;
  const others = new Set((Array.isArray(targets) ? targets : []).map(provOf).filter((x) => x !== p));
  const order = moderatorOrder(providers, { now });
  return order.slice(0, order.indexOf(p)).some((x) => others.has(x)) ? p : null;
}
/** The services signed in AND permitted on a status (`providers[p]`) — the seat's candidates (pickModeratorSeat). */
export function readyServices(providers) {
  const ps = providers || {};
  return MODERATOR_RANK.filter((p) => ps[p] && ps[p].loggedIn === true && ps[p].permitted === true);
}
/**
 * The default debate layout picked from a status — defaultDebateLayout(pickModeratorSeat) plus `ready`: the
 * services that were candidates for it (readyServices), so a later status can tell a service that has
 * BECOME ready since (repickSeat, #2087).
 */
export function pickDebateDefault({ providers, catalogs, now = Date.now() }) {
  return { ...defaultDebateLayout(pickModeratorSeat({ providers, catalogs, now })), ready: readyServices(providers) };
}
/**
 * #2087: the default layout once more services are ready than when it was picked (a new user's first status
 * reaches the page before Claude's login / site access does — the seat went to Gemini, then Claude was there).
 * `prev` = the layout picked (pickDebateDefault). Re-picked only when a service that was NOT ready at any
 * earlier pick is ready now AND the pick from this status seats exactly that service — i.e. a better candidate
 * per moderatorOrder became ready. Readiness is the only trigger: a catalog or usage that changed meanwhile
 * moves nothing (§18.9 ⑥, Codex U2 1R: no re-pick on a tab round trip), and `ready` only grows (merged on
 * every call), so each service can move the seat at most once — bounded, never back and forth.
 * Returns `prev` itself when nothing changed; a layout with the merged `ready` (same ids) when a service
 * became ready without taking the seat; else the new layout with `repicked: true`.
 * The caller decides whether the page may follow (pre-session, nothing the user chose — compare.js).
 */
export function repickSeat(prev, { providers, catalogs, now = Date.now() }) {
  if (!prev) return prev;
  const before = Array.isArray(prev.ready) ? prev.ready : [];
  const fresh = readyServices(providers).filter((p) => !before.includes(p));
  if (!fresh.length) return prev;
  const ready = MODERATOR_RANK.filter((p) => before.includes(p) || fresh.includes(p));
  const pick = pickModeratorSeat({ providers, catalogs, now });
  const seatProv = prev.seat ? String(prev.seat).split(':')[0] : null;
  if (!pick || !fresh.includes(pick.provider) || pick.provider === seatProv) return { ...prev, ready };
  return { ...defaultDebateLayout(pick), ready, repicked: true };
}
/**
 * The service the seat was picked past for its usage (`layout.passed`, defaultDebateLayout) — only for the
 * layout's own seat, and only while that service still has a column among `targets`: with its columns removed
 * it was not 「passed over」, it is not taking part (Codex #2082 1R). Null otherwise.
 */
export function seatPassed(layout, seat, targets) {
  if (!layout || !seat || layout.seat !== seat || !layout.passed) return null;
  return (Array.isArray(targets) ? targets : []).some((id) => String(id).split(':')[0] === layout.passed) ? layout.passed : null;
}
/**
 * The moderator a debate starts with when the user never chose one (`modChosen` false): the seat,
 * while it is among the targets with at least two debaters besides it (a service not signed in
 * leaves three — the seat still moderates rather than debating its own service). Without the seat on
 * the page but with 3+ AIs, one of them moderates (#1909, 2026-09-29 user decision: an unmoderated
 * debate has nobody to check facts or conclude — a shared one ran 100 turns): fallbackModerator. Fewer → auto.
 * `tierKeyOf(colId)` = a column's model-group key (for the fallback's pick), optional. `order` = the services
 * in the order the fallback tries them (moderatorOrder over the status — #2082), MODERATOR_RANK when absent.
 */
export function defaultModerator(seat, targets, tierKeyOf = null, order = null) {
  const list = Array.isArray(targets) ? targets : [];
  if (list.length < DEFAULT_MOD_MIN_TARGETS) return { moderator: MOD_AUTO, modCol: null };
  if (seat && list.includes(seat)) return { moderator: MOD_AI, modCol: seat };
  return { moderator: MOD_AI, modCol: fallbackModerator(list, tierKeyOf, order) };
}
/**
 * Which of the page's own columns moderates when the seat is not there: a FAST one (the moderator
 * speaks between every turn — not a high-end or reasoning model) of the first service in `order`
 * (MODERATOR_RANK, or moderatorOrder's usage-aware order) that has one; else the first column of that
 * order; else the last column.
 */
export function fallbackModerator(targets, tierKeyOf = null, order = null) {
  const ranks = Array.isArray(order) && order.length ? order : MODERATOR_RANK;
  const provOf = (id) => String(id).split(':')[0];
  const slow = (id) => [TIER_HIGH, TIER_REASONING].includes(tierKeyOf ? tierKeyOf(id) : null);
  for (const p of ranks) { const fast = targets.find((id) => provOf(id) === p && !slow(id)); if (fast) return fast; }
  for (const p of ranks) { const any = targets.find((id) => provOf(id) === p); if (any) return any; }
  return targets[targets.length - 1];
}
// Two debaters plus the seat — the same floor as a chosen AI moderator (planCast). A seat exists only
// in the layout it was picked with (the default one, or a stored one saved with it — plan §18.9 ①).
const DEFAULT_MOD_MIN_TARGETS = 3;

export const SPEAKER_USER = 'user';
// #1856 stage 0: the services that REPORT their web searches as activity events (Claude's web_search,
// ChatGPT's web tool). Gemini reports none, so 「no search on record」 would be every Gemini link — it
// is left out rather than flagged.
export const SEARCH_REPORTING_PROVIDERS = ['claude', 'chatgpt'];
// 「이름: Claude」 / 「이름 · Gemini」 / 「이름 - ChatGPT」 at the END of a NEXT name — the service line's shape.
const SERVICE_SUFFIX_RE = /\s*[:·•\-–—]\s*(?:claude|gemini|chatgpt)\s*$/i;
const URL_RE = /https?:\/\/[^\s<>()\[\]"'`]+/gi;
/**
 * The http(s) links in `text`, trailing punctuation dropped, lower-cased host, unique. `claimsOnly`
 * (1R): links inside code (fenced or inline — examples, not sources) and quoted lines (`> …` — someone
 * else's words) are not the speaker's claim and are skipped.
 */
export function linksIn(text, { claimsOnly = false } = {}) {
  const out = new Set();
  let src = String(text || '');
  if (claimsOnly) src = src.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ').replace(/^[ \t]*>.*$/gm, ' ');
  for (const m of src.matchAll(URL_RE)) {
    const raw = m[0].replace(/[.,;:!?。、]+$/u, '');
    try { const u = new URL(raw); out.add(`${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/$/, '')}${u.search}`); } catch { /* not a URL after all */ }
  }
  return [...out];
}
/**
 * #1856 stage 0 — a turn that brings in NEW links although it ran NO web search this turn (the links
 * are from memory, which is where invented citations come from). Only for a service that reports its
 * searches. `knownTexts` = everything already on record before this turn (the topic, every earlier
 * line — the user's, the other debaters', the moderator's — and the user's queued words): repeating
 * a link from there is quoting, not a claim (1R). [] = nothing to flag.
 */
export function unsearchedLinks({ provider, text, searches, knownTexts = [] }) {
  if (!SEARCH_REPORTING_PROVIDERS.includes(provider) || searches > 0) return [];
  const known = new Set(knownTexts.flatMap((x) => linksIn(x)));
  return linksIn(text, { claimsOnly: true }).filter((l) => !known.has(l));
}
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
// ChatGPT's 「Thinking mini」 (catalog role `thinking_mini`, #2054 E — 2026-10-04 user decision): a group of its
// own between the light Instant and the reasoning Thinking — it reasons, briefly.
const TIER_MINI = 'debate_tier_mini';
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
    { tokens: null, key: 'debate_alias_gemini', family: null, emoji: '\u{1F39B}\u{FE0F}', tier: null },                                         // gemini sign (twins)
  ],
};
// ROLE FIRST (#2054 E): the catalog's `role` (vendor-ai models.js — the site's own lane, an enum that does not
// change when a slug is renamed) names the family before any token does; the token rules above are the fallback
// for a row without a role (Claude / Gemini rows, a static list, a stored model the catalog no longer has).
// `work` names no family (Astra / Sol / Luna / Terra are told apart by their tokens) and is left to them.
const ruleByKey = (provider, key) => DEFAULT_ALIAS_RULES[provider].find((r) => r.key === key);
const ROLE_RULES = {
  chatgpt: {
    auto: ruleByKey('chatgpt', 'debate_alias_chatgpt'),
    fast: ruleByKey('chatgpt', 'debate_alias_chatgpt_instant'),
    thinking: ruleByKey('chatgpt', 'debate_alias_chatgpt_thinking'),
    thinking_more: ruleByKey('chatgpt', 'debate_alias_chatgpt_thinking'),
    thinking_max: ruleByKey('chatgpt', 'debate_alias_chatgpt_thinking'),
    thinking_mini: { ...ruleByKey('chatgpt', 'debate_alias_chatgpt_mini'), tier: TIER_MINI },
    pro: ruleByKey('chatgpt', 'debate_alias_chatgpt_pro'),
  },
};
export const TIER_KEYS = [TIER_HIGH, TIER_REASONING, TIER_MINI, TIER_BALANCED, TIER_LIGHT];
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
/**
 * `{ key, family, emoji, tier }` of the default alias for a provider + model id + catalog label (null / '' = Auto)
 * + the catalog row's `role` (ROLE_RULES — read first; null / unknown = the token rules).
 */
export function defaultAliasOf(provider, modelId, modelLabel = '', role = null) {
  const rules = DEFAULT_ALIAS_RULES[provider];
  if (!rules) return FALLBACK_ALIAS;
  const byRole = typeof role === 'string' && ROLE_RULES[provider] && Object.hasOwn(ROLE_RULES[provider], role) ? ROLE_RULES[provider][role] : null;
  if (byRole) return { key: byRole.key, family: byRole.family, emoji: byRole.emoji, tier: byRole.tier };
  const toks = modelTokens(modelId, modelLabel);
  const hit = (want) => toks.some((tok) => (want instanceof RegExp ? want.test(tok) : tok === want));
  for (const r of rules) if (!r.tokens || r.tokens.some(hit)) return { key: r.key, family: r.family, emoji: r.emoji, tier: r.tier };
  return FALLBACK_ALIAS;
}
/**
 * The tier i18n key of a model, or null. `modelId` null = Auto: then only a model the SITE REPORTED
 * serving (`served`, `{ id, label, role? }` — never a merely requested one) may name the family (§13.1 ②).
 * `role` = the catalog role of `modelId` (role first, #2054 E).
 */
export function tierOf(provider, modelId, modelLabel, served = null, role = null) {
  if (modelId != null && modelId !== '') return defaultAliasOf(provider, modelId, modelLabel, role).tier;
  if (served && (served.id || served.label)) return defaultAliasOf(provider, served.id, served.label, served.role || null).tier;
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
/**
 * The words for a model the SITE reported serving (#1818 ⑨): the catalog's display text when the id
 * is a catalog row (`gpt-6-sol-wm` → 「GPT-6 Sol · 작업 모드」), else the reported label — never a bare
 * id the catalog does not know (a label that only repeats its id says nothing a reader can use). ''
 * when nothing readable is known. `catalogText(id)` = the catalog's text for an id, '' when absent.
 */
export function servedModelText(served, catalogText) {
  if (!served || typeof served !== 'object') return '';
  const id = served.id == null ? '' : String(served.id);
  const label = served.label == null ? '' : String(served.label).trim();
  const cat = id && typeof catalogText === 'function' ? String(catalogText(id) || '') : '';
  if (cat) return cat;
  return label && label !== id ? label : '';
}

// ── Korean particles ──
const HANGUL_FIRST = 0xac00;
const HANGUL_LAST = 0xd7a3;
const HANGUL_FINALS = 28; // final-consonant slots per syllable (0 = none)
// A Latin letter / digit read aloud in Korean that ends in a consonant (엘 엠 엔 알 · 영 일 삼 육 칠 팔).
const LATIN_BATCHIM = new Set(['l', 'm', 'n', 'r', '0', '1', '3', '6', '7', '8']);
// Grammar, not UI copy (the ko strings carry the sentence): escaped so the page's source stays Hangul-free.
const SUBJECT_AFTER_BATCHIM = '\uC774'; // 이
const SUBJECT_AFTER_VOWEL = '\uAC00'; // 가
/**
 * Whether `word` ends in a final consonant as read in Korean — true / false, or null when its last
 * character says nothing (an emoji, a symbol). Closing brackets, quotes and spaces are skipped.
 */
export function endsInBatchim(word) {
  const chars = [...String(word == null ? '' : word).replace(/[\s)\]}」』"'”’.,!?…·]+$/u, '')];
  const last = chars[chars.length - 1];
  if (!last) return null;
  const code = last.codePointAt(0);
  if (code >= HANGUL_FIRST && code <= HANGUL_LAST) return (code - HANGUL_FIRST) % HANGUL_FINALS !== 0;
  if (/^[a-z0-9]$/i.test(last)) return LATIN_BATCHIM.has(last.toLowerCase());
  return null;
}
/**
 * The subject particle for `word` (#1818 ②): 「이」 after a final consonant, 「가」 otherwise, '' when
 * the word's end cannot tell — the sentence then reads without one rather than with 「이(가)」.
 */
export function subjectParticle(word) {
  const b = endsInBatchim(word);
  return b === null ? '' : b ? SUBJECT_AFTER_BATCHIM : SUBJECT_AFTER_VOWEL;
}

/** Every line quoted, the first one carrying `first` — a line break cannot leave the quote (export.js's rule). */
const quoteMd = (text, first = '') => String(text).split('\n').map((line, i) => `> ${i === 0 ? first : ''}${line}`).join('\n');
/**
 * A debate session as ONE markdown document (「전체 복사」, #1769 §0.4 ⑤): the topic, then what the
 * timeline SHOWS, in its order — never the composed prompts the columns' user turns carry (they
 * would read as the user's questions) nor a moderator's control line (`text` is the shown body).
 *   entries: { role, name, text, meta?, note?, opening?, conclusion? } — `note` is the line a failed /
 *            cut turn shows under whatever it wrote; an entry with neither text nor note is left out;
 *            `conclusion` = the moderator's closing message, under the same label the timeline shows.
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
    if (e.conclusion) blocks.push('---', `## ${t('debate_conclusion')}`);
    blocks.push(`**${name}**${e.meta ? ` \u00B7 ${e.meta}` : ''}`);
    if (text.trim()) blocks.push(text);
    if (note) blocks.push(`_${mdInlineText(note)}_`);
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
/**
 * The conclusion's shape (2026-09-30 user): bold labels + short bullets (결론 / 합의된 점 / 남은 쟁점 /
 * 판단 근거 / 판단이 바뀔 조건 / 직접 확인할 사실), not prose and not `#` headings — a heading renders
 * too large in a chat bubble. One text for a debater's conclusion and the moderator's.
 */
const conclusionFormat = (t, tone) => t(friendly(tone) ? 'debate_conclusion_format_friends' : 'debate_conclusion_format');

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
 * The debate names of `people` (`[{ id, provider, model, modelLabel, modelRole?, alias, label }]` — `alias` the
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
    { const d = defaultAliasOf(p.provider, p.model, p.modelLabel, p.modelRole); names.set(p.id, { name: alias, emoji: d.emoji, custom: true, words: familyWords(d.family, t) }); }
  }
  // Defaults: a family shared by several participants (or whose name a custom alias took) names
  // each of them by its version, then by its whole label, then by a number (plan §11.4 ②) — the
  // real model stays readable in the name, and two Opus columns never read as the same speaker.
  const defs = people.filter((p) => !names.has(p.id)).map((p) => ({ p, def: defaultAliasOf(p.provider, p.model, p.modelLabel, p.modelRole) }));
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
/**
 * The stance i18n keys of each debater (`ids` in speaking order) under the run's `stance` value; Map
 * id → [key, …] | null. For/against alternates over everyone; the roles go from the end — the
 * contrarian to the last debater, the verifier to the last one without a role (the last when alone, as
 * before). A debater may hold a side AND a role (for/against + verifier). With more roles than
 * debaters the extra role is left out.
 */
export function stancesOf(ids, stance) {
  const { base, roles } = splitStance(stance);
  const keys = new Map(ids.map((id) => [id, []]));
  if (base === STANCE_PRO_CON) ids.forEach((id, i) => keys.get(id).push(i % 2 === 0 ? 'debate_stance_pro' : 'debate_stance_con'));
  let seat = ids.length - 1;
  for (const role of [STANCE_DEVIL, STANCE_VERIFY]) {
    if (!roles.includes(role) || seat < 0) continue;
    keys.get(ids[seat]).push(`debate_stance_${role}`);
    seat -= 1;
  }
  return new Map([...keys].map(([id, ks]) => [id, ks.length ? ks : null]));
}
/** A debater's position line text: its stance keys (one key or a list) worded and joined. */
export const stanceText = (t, keys) => (Array.isArray(keys) ? keys : [keys]).filter(Boolean).map((k) => t(k)).join('; ');

// ── prompts ──
// The user is NOT told to be nameless (2026-09-28 user decision, reverting #1851): an AI that knows the
// account's name (Claude does) may call the user by it — 「사용자,」 read stiff, most of all in the friends tone.
// Every prompt carries `debate_call_full_name` (2026-09-27): default names are `<trait> <model>`
// (쌍둥이 제미, 교수 GPT), and a model reads the trait as a title and calls the speaker by the tail
// alone — 「제미 님」「GPT 님」 — which names nobody once two of a service take part.
// Prompt wording (2026-09-27 quality pass, user request): techniques adapted from open-source debate
// work — per-turn reasoning steps, "repeating adds nothing / add one new point", and "no 'in
// conclusion' mid-debate" from ucl-dark/llm_debate (Khan et al. 2024, MIT); the critic role that
// questions the others from thunlp/ChatEval (Apache-2.0); one question at a time, with options, from
// obra/superpowers' brainstorming skill (MIT). Ideas only, no wording, from Multi-Agents-Debate (Liang
// et al., GPL-3.0 — debaters are told disagreement is fine because the aim is the best answer) and
// the llm-council chairman's two-step synthesis (candidates first, then the call). The wording
// itself lives in compare-i18n.js.
// 2026-09-29 rework (#1909 — a shared 104-turn debate was nitpicking, unsourced and never concluded):
// the reader is the USER, who wants an answer — rebut only what would change it (no nitpicks), concede
// what is right, a point argued back and forth twice is left as 「where we differ」, a new point only if
// it could change the conclusion, facts are searched and linked or said to be uncertain (never invented
// names/figures — a light model made up three programme names), and the user's words come first.
/**
 * The opening. Everyone answers blind (nobody has seen anyone else yet), which is the point of
 * opening simultaneously. `self` = `{ name, stanceKey }` of the debater this copy goes to (the SEND
 * carries one text per column — #1815): its own name and position on a line of their own, right
 * before the task. The cast list alone was not enough — two columns of one service (GPT-6 Sol and
 * GPT-6 Astra) cannot tell which list line is theirs, and one argued the other's side. Without
 * `self` the text names the cast but not the reader (the generic copy the wire's `text` keeps).
 */
export function openingPrompt({ t, names, moderatorName, stanceLines, topic, tone, self = null, length = LENGTH_NORMAL }) {
  const lines = [t('debate_open_head', names.join(', ')), t('debate_call_full_name'), moderatorName ? t('debate_open_moderator', moderatorName) : t('debate_open_user_moderates')];
  if (stanceLines && stanceLines.length) lines.push(t('debate_open_stances'), ...stanceLines);
  if (self && self.name) lines.push(t('debate_turn_you_are', self.name) + (self.stanceKey ? ` ${t('debate_turn_stance', stanceText(t, self.stanceKey))}` : ''));
  lines.push(t(friendly(tone) ? 'debate_open_task_friends' : 'debate_open_task'));
  lines.push(t(friendly(tone) ? 'debate_fact_rule_friends' : 'debate_fact_rule'));
  lines.push(debaterLengthLine(t, 'open', length, tone));
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
export function turnPrompt({ t, selfName, stanceKey, delta, instruction, firstReply, tone, length = LENGTH_NORMAL, long = false, conclude = false }) {
  const lines = [];
  if (firstReply) lines.push(t('debate_turn_you_are', selfName) + (stanceKey ? ` ${t('debate_turn_stance', stanceText(t, stanceKey))}` : ''));
  lines.push(t('debate_turn_head'));
  if (delta.items.length) lines.push(renderItems(delta.items, t));
  if (delta.omitted) lines.push(t('debate_omitted', delta.omitted));
  if (instruction) lines.push(t('debate_turn_instruction', neutraliseQuoted(instruction)));
  const f = friendly(tone);
  // The conclusion (#1909 — no AI moderator): the whole debate, not this debater's side; no new facts.
  if (conclude) {
    lines.push(t(f ? 'debate_conclude_task_friends' : 'debate_conclude_task'));
    lines.push(t('debate_call_full_name'));
    const st = styleLine(tone, t, false);
    if (st) lines.push(st);
    // Last: the format overrides any 「no lists」 / length words above it — a user's own tone line included.
    lines.push(conclusionFormat(t, tone));
    return lines.join('\n');
  }
  lines.push(t(f ? 'debate_turn_task_friends' : 'debate_turn_task'));
  lines.push(t(f ? 'debate_fact_rule_friends' : 'debate_fact_rule'));
  // The user's words come first — and when they ask for a conclusion, the debater may give one: the 「no
  // wrap-up」 line stays off that turn (#1909: 「그만들 하고 결론을 내봐」 was answered with 「아직 안 끝났으니
  // 정리 없이」 on every turn after it).
  lines.push(t(delta.items.some((i) => i.role === ROLE_USER) ? (f ? 'debate_turn_user_first_friends' : 'debate_turn_user_first') : (f ? 'debate_turn_no_wrap_friends' : 'debate_turn_no_wrap')));
  lines.push(debaterLengthLine(t, 'turn', length, tone));
  // The moderator's LONG — granted by the page, not left to the debater to notice (#1862). A user's 「자세히」
  // is in the delta above and the length line lets the debater act on it itself.
  if (long) lines.push(t('debate_len_granted'));
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
export function moderatorPrompt({ t, names, lastName, delta, first, topic, canEnd, tone, wrapUp = false, freeStance = false, pace = PACE_QUICK, turnsUsed = 0, canAsk = false, services = null, length = LENGTH_NORMAL }) {
  const lines = [];
  if (first) lines.push(t(friendly(tone) ? 'debate_mod_intro_friends' : 'debate_mod_intro'), t('debate_topic_label'), neutraliseQuoted(String(topic || '').slice(0, DEBATE_TOPIC_MAX)));
  // Numbered (plan §14.2): the moderator names the next speaker by NUMBER — free-text names were
  // ambiguous four review rounds in a row. The number is the position in `names`.
  lines.push(t('debate_mod_cast', names.map((n, i) => `${i + 1} ${n}`).join(', ')));
  // Each debater's service on a line of its own (#1856 ②: a disputed fact goes to another COMPANY's AI) —
  // NOT on the cast line, whose words a NEXT echoes (1R: 「NEXT: 거장 오퍼스 · Claude」 matched two Claudes).
  if (services && services.some(Boolean)) lines.push(t('debate_mod_services', names.map((n, i) => `${n}: ${services[i] || '?'}`).join(', ')));
  lines.push(t('debate_turn_head'));
  if (delta.items.length) lines.push(renderItems(delta.items, t));
  if (delta.omitted) lines.push(t('debate_omitted', delta.omitted));
  // Right after the opening nobody spoke last — the 「you may not pick X」 clause is left out then.
  // Which call is a CONCLUSION call is decided here, not guessed from the reply: `wrapUp` (the budget's
  // last send — the page sends it only to close) MUST end, so its task is the conclusion task and
  // the short 「one or two sentences」 one is left out (#1817 follow-up). Any other call with `canEnd`
  // only MAY end — the moderator decides — so it keeps the short task, and the END branch of the
  // control line (debate_mod_control) carries the conclusion format for that case.
  const taskKey = friendly(tone) ? 'debate_mod_task_friends' : 'debate_mod_task';
  if (wrapUp) lines.push(t('debate_mod_task_conclude'));
  else {
    lines.push(lastName ? t(taskKey, lastName) : t(`${taskKey}_open`));
    lines.push(t('debate_len_mod_line', t(`debate_len_mod_${lengthOf(length)}`)));
  }
  // A free debate whose openings all land on one side is a dull one (#1817 ④): on its first call —
  // the one that reads the openings — the moderator may hand one debater the other side.
  if (first && freeStance) lines.push(t('debate_mod_same_side'));
  // #1856 ①②: facts, checked where it is cheap. Right after the blind openings (before anyone has
  // read the others — research: one round of debate erases dissent, and outside checks stop changing
  // the verdict) a clash of FACTS gets its sources asked for; later a still-unsourced clash is handed
  // to another company's AI to check by search. Opinions are not the target. No extra call either way.
  if (!wrapUp) lines.push(t(first ? 'debate_mod_fact_check' : 'debate_mod_verify_rule'));
  // 「깊게」 (#1843) and 「충분히」: not only picking up points the debaters raised — the moderator brings one of its own.
  if (pace !== PACE_QUICK && !wrapUp) lines.push(t(friendly(tone) ? 'debate_mod_deepen_friends' : 'debate_mod_deepen'));
  // What only the user knows (their situation, constraints, preferences) is asked, not guessed (#1843).
  if (canAsk && !wrapUp) lines.push(t('debate_mod_ask_rule'));
  lines.push(t('debate_call_full_name'));
  const style = styleLine(tone, t, true);
  if (style) lines.push(style);
  // The last send of the budget: the moderator closes the debate (plan §15.1 ③).
  if (wrapUp) lines.push(t('debate_mod_wrapup'));
  else lines.push(t('debate_mod_long_rule'));
  // A call that may (or must) END reads the conclusion's format right above the control line, whose END
  // branch points at it — the control line itself stays the last thing read.
  if (wrapUp || canEnd) lines.push(conclusionFormat(t, tone));
  // The control line instruction is ALWAYS the last thing the moderator reads, whatever the tone (§12.1 ①②).
  lines.push(t(controlKey({ canEnd, wrapUp, end: endRule({ pace, turnsUsed }), canAsk })));
  return lines.join('\n');
}

// Who decides an AI moderator's END (the wrap-up aside, which must end): the moderator once no new point
// comes up (「빠르게」), the moderator once the angles left would not change the answer (「충분히」 past its
// minimum turns), or the USER only (「깊게」, and 「충분히」 before its minimum).
export const END_SELF = 'self';
export const END_ENOUGH = 'enough';
export const END_ON_REQUEST = 'on_request';
export function endRule({ pace, turnsUsed }) {
  if (pace === PACE_QUICK) return END_SELF;
  if (pace === PACE_BALANCED && turnsUsed >= DEBATE_BALANCED_MIN_TURNS) return END_ENOUGH;
  return END_ON_REQUEST;
}
/**
 * Which control-line instruction the moderator reads last: the wrap-up MUST end; otherwise END is
 * offered only when the page would accept it (`canEnd`), worded by who decides it (`end` — endRule),
 * and ASK only while the run has asks left.
 */
const CONTROL_BY_END = { [END_SELF]: 'debate_mod_control', [END_ENOUGH]: 'debate_mod_control_enough', [END_ON_REQUEST]: 'debate_mod_control_on_request' };
export function controlKey({ canEnd, wrapUp, end, canAsk }) {
  if (wrapUp) return 'debate_mod_control';
  const base = !canEnd ? 'debate_mod_control_no_end' : CONTROL_BY_END[end] || CONTROL_BY_END[END_ON_REQUEST];
  return canAsk ? `${base}_ask` : base;
}
/**
 * May an AI moderator END now (the wrap-up aside)? After `minTurns` debater turns, never with the
 * user's words still queued — and while endRule says END_ON_REQUEST (「깊게」, 「충분히」 before its
 * minimum) only right after the USER spoke (#1843, 1R): the prompt tells it to end only when the user
 * asks, and the page holds it to that, so a moderator that concludes on its own is read as no control
 * (the rule picks the next speaker).
 */
/**
 * Has the user spoken since the moderator last ANSWERED (#1843)? Read backwards through the
 * transcript: a user line first → yes; an answered moderator line first → no. A moderator call that
 * is still pending, failed (no words — 3R), or is the one being judged (`skip`) does not count as an
 * answer: the user's 「마무리해 줘」 is still waiting for one.
 */
export function userSpokeSince(transcript, skip = null) {
  for (let i = (transcript || []).length - 1; i >= 0; i--) {
    const e = transcript[i];
    if (!e || e.seq === skip) continue;
    if (e.role === ROLE_USER) return true;
    if (e.role === ROLE_MODERATOR && !e.pending && String(e.text || '').trim()) return false;
  }
  return false;
}
export function moderatorCanEnd({ pace, turnsUsed, minTurns, queued, userSpoke }) {
  return turnsUsed >= minTurns && !queued && (endRule({ pace, turnsUsed }) !== END_ON_REQUEST || !!userSpoke);
}

// ── the moderator's control line ──
// Only the LAST non-empty line counts: a NEXT inside the body may be a quote of someone else.
// The Korean forms (다음: / 끝 / 종료) are written as escapes — the i18n guard keeps Hangul out of code.
const CONTROL_NEXT_RE = /^\s*[*_`]*\s*(?:NEXT|\uB2E4\uC74C)\s*[:：]\s*(.+?)\s*[*_`]*\s*$/i;
const CONTROL_END_RE = /^\s*[*_`]*\s*(?:END|\uB05D|\uC885\uB8CC)\s*[.!]?\s*[*_`]*\s*$/i;
// ASK / 질문 (#1843): the moderator asks the user — the body is the question.
const LONG_TAIL_RE = /\s+(?:LONG|\uAE38\uAC8C)\s*$/i; // LONG / 길게 at the end of a NEXT
const CONTROL_ASK_RE = /^\s*[*_`]*\s*(?:ASK|\uC9C8\uBB38)\s*[.!?]?\s*[*_`]*\s*$/i;
// A label line of the conclusion format (`**합의된 점**`), a code fence opener, list items and table rows.
const FORMAT_LABEL_RE = /^\*\*([^*\n]+)\*\*/gm;
const ANY_FENCE_RE = /^ {0,3}(?:```|~~~)/m;
const BULLET_LINE_RE = /^[-*+][ \t]+\S/;
const NOT_PARAGRAPH_RE = /^(?:\s|\d+[.)][ \t]|[#>|])|\|/;
const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * The section labels a conclusion-format text asks for (`debate_conclusion_format`) — read off the format
 * itself, so the labels tightenConclusion looks for can never drift from the ones the model is shown.
 */
export function conclusionLabels(formatText) {
  return [...new Set([...String(formatText || '').matchAll(FORMAT_LABEL_RE)].map((m) => m[1]))];
}
/**
 * A conclusion with a blank line put back before a format label glued to the line above. The format asks
 * for blank lines, but a model that drops them writes `- bullet\n**남은 쟁점**` — a lazy continuation that
 * pulls the label into the bullet. ONLY that case (Codex 2R·3R): the line must be one of `labels` alone or
 * followed by `:` (a label that starts a sentence — `**Why** it matters` — is prose) and the line above an unordered bullet or a plain paragraph line — never a table row or a
 * numbered item. A text with any code fence is returned as is (a conclusion has no code; fences are not
 * worth parsing here). A text that needs nothing comes back as the same string.
 */
export function tightenConclusion(text, labels) {
  const src = String(text || '');
  const names = (labels || []).filter(Boolean);
  if (!names.length || ANY_FENCE_RE.test(src)) return src;
  const labelRe = new RegExp(`^\\*\\*(?:${names.map(escapeRe).join('|')})\\*\\*[ \\t]*(?::|$)`);
  const lines = src.split('\n');
  const out = [];
  for (const line of lines) {
    const prev = out.length ? out[out.length - 1] : '';
    if (labelRe.test(line) && prev.trim() && (BULLET_LINE_RE.test(prev) || !NOT_PARAGRAPH_RE.test(prev))) out.push('');
    out.push(line);
  }
  return out.length === lines.length ? src : out.join('\n');
}
/**
 * `{ body, control }` of a moderator reply: `control` = `{ kind: 'next', name }` | `{ kind: 'end' }`
 * | `{ kind: 'ask' }` | null, `body` = the text without the control line (what the timeline shows and the debaters get).
 */
export function splitControl(text) {
  const lines = String(text || '').split('\n');
  let i = lines.length - 1;
  while (i >= 0 && !lines[i].trim()) i--;
  if (i < 0) return { body: '', control: null };
  const last = lines[i];
  let control = null;
  const next = CONTROL_NEXT_RE.exec(last);
  // The name is kept whole: a LONG / service tail is read off in chooseAfterModerator, AFTER an exact
  // alias match (1R: an alias 「거장 오퍼스 LONG」 beside 「거장 오퍼스」).
  if (next) control = { kind: 'next', name: next[1] };
  else if (CONTROL_END_RE.test(last)) control = { kind: 'end' };
  else if (CONTROL_ASK_RE.test(last)) control = { kind: 'ask' };
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
// Who writes a conclusion when there is no AI moderator (#1909): the eligible debater of the strongest
// model group, page order on a tie — a light model is the last choice (in the shared debate a light
// model was the one inventing programme names). `tierKeyOf(id)` = its tier i18n key, or null (Auto / unknown).
const CONCLUDER_RANK = { [TIER_HIGH]: 4, [TIER_REASONING]: 3, [TIER_BALANCED]: 2, [TIER_LIGHT]: 0 };
const UNKNOWN_TIER_RANK = 1;
export function pickConcluder({ order, eligible, tierKeyOf }) {
  let best = null;
  for (const id of order) {
    if (!eligible.has(id)) continue;
    const k = tierKeyOf(id);
    const rank = Object.hasOwn(CONCLUDER_RANK, k) ? CONCLUDER_RANK[k] : UNKNOWN_TIER_RANK;
    if (!best || rank > best.rank) best = { id, rank };
  }
  return best ? best.id : null;
}

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
 * Who is still owed the floor once the user's pick (`forced`) has spoken (#1817 ③): the debater the
 * moderator had just picked (`pendingNext`) keeps its turn — its question sits in the transcript,
 * and a user interjecting must not make it vanish unanswered. null when there is none, or the user
 * picked that same debater.
 */
export function owedAfterForced(pendingNext, forced) {
  return pendingNext && pendingNext !== forced ? pendingNext : null;
}

/**
 * What the budget allows next (plan §15.1 ①): 'stop' when nothing is left, 'go' otherwise. There is no
 * automatic wrap-up any more (2026-09-28): the last send went to the moderator's conclusion even when
 * it had just asked a debater something — the stop asks the user instead (extend, or conclude).
 */
export function budgetStep({ used, budget }) {
  return budget - used <= 0 ? 'stop' : 'go';
}
// `chrome.idle` states (#1971): anything but these two is someone at the computer.
const IDLE_AWAY_STATES = ['idle', 'locked'];
/**
 * The system idle clock (#1971 §3.1) after a `chrome.idle` report: `{ state, since }`, `since` = when the
 * computer was last used (null while active). 「idle」 arrives `detectS` seconds after the last input, so
 * it is dated back by that much; 「locked」 counts from the report. idle → locked keeps the earlier start.
 */
export function idleAfter(prev, state, now, detectS) {
  if (!IDLE_AWAY_STATES.includes(state)) return { state: 'active', since: null };
  const was = prev && IDLE_AWAY_STATES.includes(prev.state) && Number.isFinite(prev.since) ? prev.since : null;
  const start = state === 'idle' ? now - detectS * 1000 : now;
  return { state, since: was === null ? start : Math.min(was, start) };
}
/**
 * Nobody has been at the computer long enough that the next send should wait for the user (#1971 §3.1,
 * replacing §15.1 ②'s hidden-tab clock): only while the tab is HIDDEN (2026-10-02 user decision — a
 * visible tab never pauses), only with the option on, and only after `limit` ms idle / locked.
 */
export function awayTooLong({ on, hidden, idle, now, limit }) {
  return on !== false && !!hidden && !!idle && IDLE_AWAY_STATES.includes(idle.state) && Number.isFinite(idle.since) && now - idle.since >= limit;
}
/**
 * The run's absolute cap (#1971 §3.3 ②) — no option lifts it and no 「늘려서 계속」 / 「결론 내기」 grant
 * passes it. `used` = counted sends since the cap last restarted. 'stop' at the cap; 'wrap' when one
 * send is left and someone can conclude — that last send is the conclusion; 'go' otherwise.
 */
export function hardCapStep({ used, cap, canConclude }) {
  if (used >= cap) return 'stop';
  if (used === cap - 1 && canConclude) return 'wrap';
  return 'go';
}

// #1971 §4.1: the stops a debate waits in for the user — `paused_as` names the one the user left from.
// The values are debate.js's PHASE_* strings (test/compare-debate-guard.mjs pins them, and the worker's list).
export const DEBATE_PAUSED_AS = Object.freeze(['hidden', 'budget', 'asked', 'paused', 'await']);
const OUTCOME_LEFT = 'left';
const OUTCOME_BUDGET = 'budget';

/**
 * The milliseconds a run has spent behind a hidden tab: what was banked at earlier reveals plus the
 * current hidden stretch, counted from the run's start at the earliest (a run started in a hidden tab).
 */
export function hiddenMsOf({ banked, since, run, now }) {
  const open = Number.isFinite(since) ? Math.max(0, now - Math.max(since, run)) : 0;
  return (banked || 0) + open;
}

/**
 * What one reportFinish call sends (#1842, #1971 §4.1), or null to send nothing. An end the run already
 * reported in the same place is not sent twice. `left` (새 대화, another session, the page closing) is
 * sent only for a run that moved since its last report — a concluded debate that was then left keeps
 * its real ending — EXCEPT a run left in a stop that waits for the user (a spent budget): that row is
 * marked once (`leftAtStop`, same outcome) so 「left + left while stopped」 counts every walk-away.
 */
export function finishReport({ outcome, moved, reported, phase, sendsUsed }) {
  if (outcome !== OUTCOME_LEFT) {
    if (reported && reported.outcome === outcome && reported.moved === moved) return null;
    return { outcome, pausedAs: null, leftAtStop: null };
  }
  if (!sendsUsed) return null;
  const pausedAs = DEBATE_PAUSED_AS.includes(phase) ? phase : null;
  if (!reported || reported.moved !== moved) return { outcome, pausedAs, leftAtStop: !!pausedAs };
  // Only a budget row waits for the user: a concluded run resumed and stopped again unsent (quota) keeps its ending (Codex 1R).
  if (pausedAs && !reported.leftAtStop && reported.outcome === OUTCOME_BUDGET) return { outcome: reported.outcome, pausedAs, leftAtStop: true };
  return null;
}

/**
 * The next debater after a moderator reply: its NEXT name when that is a real, eligible debater
 * other than `prev`; otherwise the rule (`fallback: true`). `end` when it said END and ending is allowed;
 * `ask` when it asked the user (ASK) and asking is allowed (#1843) — else an ASK is no control at all.
 */
export function chooseAfterModerator({ control, candidates, order, eligible, prev, lastSpoke, canEnd, canAsk = false, numbered = null }) {
  if (control && control.kind === 'end' && canEnd) return { end: true, id: null, fallback: false };
  if (control && control.kind === 'ask' && canAsk) return { ask: true, id: null, fallback: false };
  if (control && control.kind === 'next') {
    // Resolution order (plan §14.2, Codex meta 5R): each step either DECIDES or passes on — a step
    // that recognised its form never hands a failure to the next (that is how `12 플래시 토끼` became
    // a name and a dropped 「3호기」 became number 3).
    //  1) the string is exactly a debater's name (whitespace / case aside), looked up among ALL of
    //     them, dropped ones too — that person, or the rule when they cannot speak;
    //  2) it starts with a number — the position in `numbered` (the order that moderator call was
    //     shown: `2`, `2번`, `#2`, `2 이름`), or the rule when the number points nowhere usable;
    //  3) otherwise a name (matchSpeaker over the debaters who can speak).
    // A service echoed from the 「참가자별 서비스」 line (#1856 2R: 「거장 오퍼스: Claude」) is not part of the
    // name — unless the whole string IS someone's name (3R: an alias 「Mira - Claude」 beside 「Mira」).
    // 「NEXT: 2 LONG」 (#1862): the moderator lets that speaker answer at length — the grant rides on the pick.
    // Tails come off only when the string as it stands is nobody's exact name.
    const raw = String(control.name || '');
    const isExact = (x) => candidates.some((c) => c.names.some((n) => normName(n) === normName(x)));
    let text = raw;
    let long = false;
    if (!isExact(text) && LONG_TAIL_RE.test(text)) { text = text.replace(LONG_TAIL_RE, ''); long = true; }
    if (!isExact(text)) text = text.replace(SERVICE_SUFFIX_RE, '');
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
    if (usable(id)) return { end: false, id, fallback: false, ...(long ? { long: true } : {}) };
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
  if (raw.pace !== undefined && !PACES.includes(raw.pace)) return undefined;
  if (raw.pb !== undefined && typeof raw.pb !== 'boolean') return undefined;
  if (raw.vf !== undefined && typeof raw.vf !== 'boolean') return undefined;
  if (raw.length !== undefined && !LENGTHS.includes(raw.length)) return undefined;
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
    for (const k of ['mod', 'o', 'end', 'ce', 'ask']) if (e[k] !== undefined && typeof e[k] !== 'boolean') return undefined;
    if (e.end && !e.mod) return undefined; // a moderator's conclusion is `end`…
    // …a debater's (#1909 — no AI moderator) is `ce`: a 1.42–1.47 reader refuses `end` on a debater and would
    // drop the whole entry; it ignores `ce` and shows the turn as a plain one.
    if (e.ce && e.mod) return undefined;
    if ((e.tk !== undefined && !TIER_KEYS.includes(e.tk)) || (e.s !== undefined && !(Number.isFinite(e.s) && e.s >= 0))) return undefined;
    // A moderator line is the moderator column's; a debater's is a debater's (the flag decides how the text is read).
    if ((e.mod === true) !== (e.c === modCol)) return undefined;
    // `ask` (the moderator asked the user): a 1.49.1-and-earlier reader ignores it (the question shows as a plain
    // moderator line). Only a moderator asks — on any other line it is ignored, never a reason to drop the entry.
    log.push({ q: e.q, c: e.c, r: e.r, ...(e.mod ? { mod: true } : {}), ...(e.end ? { end: true } : {}), ...(e.ce ? { ce: true } : {}), ...(e.mod && e.ask ? { ask: true } : {}), ...(e.o ? { o: true } : {}), ...(e.tk ? { tk: e.tk } : {}), ...(e.s !== undefined ? { s: e.s } : {}) });
  }
  const prev = raw.prev == null ? null : (isDebater(raw.prev) ? raw.prev : undefined);
  const fr = idList(raw.fr === undefined ? [] : raw.fr, isDebater);
  const el = idList(raw.el === undefined ? debaters : raw.el, isDebater);
  const turns = raw.turns === undefined ? 0 : raw.turns;
  for (const k of ['modStarted', 'done', 'legacy']) if (raw[k] !== undefined && typeof raw[k] !== 'boolean') return undefined;
  if (prev === undefined || !fr || !el || !nonNegInt(turns)) return undefined;
  // `asks` = the run's question count, kept beside the log (whose oldest lines the bound may cut). A 1.49.1 reader
  // ignores the unknown key. Capped: nothing past DEBATE_MAX_ASKS changes what the moderator may do.
  if (raw.asks !== undefined && !nonNegInt(raw.asks)) return undefined;
  const tone = normalizeTone(raw.tone.kind, raw.tone.custom || '');
  // A record from before 「깊게」 (#1843) ran the quick way — it goes on as it was.
  // The verifier is stored as `vf: true` beside the rest of the stance (1R: a 1.42 reader refuses an unknown
  // stance and then drops the whole entry — this way it reads the debate without the verifier). Since the
  // roles split (2026-09-29) vf may ride on 'procon' / 'devil' too; a normalised record may carry the composite.
  const st = splitStance(raw.stance);
  const stance = raw.vf === true ? composeStance(st.base, [...st.roles, STANCE_VERIFY]) : raw.stance;
  const pace = raw.pb === true && raw.pace === PACE_DEEP ? PACE_BALANCED : raw.pace || PACE_QUICK; // recordPace
  return { debaters, modCol, modKind: raw.modKind, stance, pace, length: raw.length || LENGTH_NORMAL, tone, aliases, log, dl, prev, fr, el, turns, modStarted: raw.modStarted === true, done: raw.done === true, ...(raw.asks ? { asks: Math.min(raw.asks, DEBATE_MAX_ASKS) } : {}), ...(raw.legacy === true ? { legacy: true } : {}) };
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
  return { debaters, modCol, modKind: modCol ? MOD_AI : MOD_AUTO, stance: STANCE_NONE, pace: PACE_QUICK, length: LENGTH_NORMAL, tone: normalizeTone(TONE_FRIENDS, ''), aliases: {}, log, dl, prev, fr: [...fr], el: debaters.slice(), turns, modStarted, done: false, legacy: true };
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
    transcript.push({ seq: e.q, speaker: e.c, role: e.mod ? ROLE_MODERATOR : ROLE_PARTICIPANT, text, round: e.r, ...(e.ask ? { ask: true } : {}), ...(e.end || e.ce ? { conclusion: true } : {}), ...(e.o ? { opening: true } : {}), ...(e.tk ? { tierKey: e.tk } : {}), ...(e.s !== undefined ? { secs: e.s } : {}) });
    if (!e.mod && text.trim()) lastSpoke.set(e.c, e.q);
  }
  return { transcript, lastSpoke };
}
