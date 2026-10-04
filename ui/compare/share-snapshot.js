// ui/compare/share-snapshot.js — the SHARE SNAPSHOT builder (#1784 U3, docs/plans/compare-share.md
// §9.4). PURE: a normalised history entry (history.js normalizeEntry — the live session goes through
// snapshotSession → normalizeEntry first) in, the snapshot the server's rebuildSnapshot accepts out
// (worker/src/utils/compare-share.ts — its header table is the SoT of the wire shape). No DOM, no
// chrome.*, no clock: test/compare-share-snapshot-probe.mjs runs it under Node against the worker's
// real validator.
//
// 🔴 WHAT IS NOT SENT is the point of this file. A history entry's `text` is in several places a
// prompt the PAGE assembled, not words anyone said: a 「요약·비교」 request carries every other
// column's answer (its structure is stored instead of text), and a debate's user turns are composed
// prompts — the user's own words are the record's `log[].u`. A pasted-link round's user turn is the
// user's text (the link frame is composed in the SW and never stored). So every field below is read
// from the one place that holds what was SAID, per the §9.4 table:
//   compare round   q = the round's user turn text (first round: entry.question) · qImages = count
//                   · att = each file's KIND (image / pdf / docx …, never its name)
//                   answers = each column's LAST assistant turn in the round: text + state
//                   (+ ms {first, total?} — its timing, complete answers only)
//   summary round   q = summary.question · the judge column's answer only (kind 'summary', judge).
//                   A round is a summary round when its ANSWER says so (kind 'summary'): a request
//                   written before structures is stored as bare text — the assembled prompt, other
//                   columns' answers inside — and normalizeEntry reads it as a plain user turn, so
//                   the request's text is never trusted as a question (Codex U3a 1R blocker).
//   debate          timeline = [topic (entry.question) + att] + transcriptFromRecord order: user = log[].u,
//                   AI = the turn's text (a moderator's without its control line), error = '' + state
//                   avatars = each speaker's avatar EMOJI (the page's, else the default alias's) —
//                   never a custom profile photo
// A column's `model` is a DISPLAY label (shareModelLabel): the catalog's text for the served model,
// never a bare internal id such as `gpt-6-sol-wm` (#1818 ⑨ — the page's rule, servedModelText).
// Never sent: errorText, model ids, continuation, attachment names/bytes/ids, generated images,
// the summary's attachments, composed debate prompts, control lines, the session id, `src`.

import { TURN_KIND_SUMMARY, ATTACH_MAX_FILES, SHARE_TITLE_MAX, ATTACH_KIND_IMAGE, ATTACH_KIND_FILE } from './constants.js';
import { docCountOf, attachKindsOf } from './image-store.js';
import { attachTypeOf, attachKindOf } from './attach-types.js';
import { readTiming } from './helpers.js';
import { transcriptFromRecord, SPEAKER_USER, ROLE_MODERATOR, servedModelText, defaultAliasOf } from './debate-core.js';

export const SHARE_SNAPSHOT_VERSION = 1;
/** The server's per-turn cap (compare-share.ts TEXT_MAX) — a longer text is a 400, so it is cut here. */
export const SHARE_TEXT_MAX = 60000;
/** The server's column cap and key alphabet (c1..c6, compare-share.ts COLUMN_KEY_RE). */
export const SHARE_COLUMNS_MAX = 6;
export const SHARE_Q_IMAGES_MAX = 10;
export const SHARE_ROUNDS_MAX = 200;
export const SHARE_TIMELINE_MAX = 2000;
const CUT_MARK = '…';
/** The server's one-line label caps (compare-share.ts LABEL_MAX / ALIAS_MAX / TITLE_MAX). */
export const SHARE_LABEL_MAX = 60;
export const SHARE_ALIAS_MAX = 40;
/** The server's timing cap (compare-share.ts TIMING_MAX_MS) — a longer clock is dropped there, so not sent. */
export const SHARE_TIMING_MAX_MS = 60 * 60 * 1000;
/** The server's avatar rule (compare-share.ts AVATAR_MAX_CP / AVATAR_RE), mirrored so an avatar the
 *  server would drop is never sent — the probe checks both accept the same samples. */
export const SHARE_AVATAR_MAX = 8;
const AVATAR_RE = /^(?=.*\p{Extended_Pictographic})[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d\ufe0f\u20e3\u{e0020}-\u{e007f}]+$/u;
/** An avatar emoji the server keeps, else ''. */
export const shareAvatar = (v) => (typeof v === 'string' && Array.from(v).length <= SHARE_AVATAR_MAX && AVATAR_RE.test(v) ? v : '');
// The server folds these runs to one space in every label (compare-share.ts LABEL_JUNK_RE): C0/C1
// controls and the bidi overrides/isolates. Mirrored so what goes up is what the server keeps —
// the guard compares the two byte for byte.
const LABEL_JUNK_RE = /[\s\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g;
/** A one-line label exactly as the server rebuilds it: folded, trimmed, cut to `max` code points with …. */
export function shareLabel(v, max) {
  if (typeof v !== 'string') return ''; // the server's cleanLabel: a non-string is no label (Codex U3a 2R follow-up)
  const one = v.replace(LABEL_JUNK_RE, ' ').trim();
  const cps = Array.from(one);
  return cps.length <= max ? one : cps.slice(0, Math.max(0, max - 1)).join('') + CUT_MARK;
}

/**
 * A stored column's model as words a reader knows: the served model's catalog text (else its
 * reported label, when that is not just its id), else the catalog text of the column's own model,
 * else '' (the provider alone). `labelOf(provider, id)` = the catalog label, which echoes the id
 * when the catalog has no such row — an echo counts as nothing.
 */
export function shareModelLabel(stored, labelOf) {
  if (!stored || typeof stored !== 'object') return '';
  const catalogText = (id) => {
    const text = typeof labelOf === 'function' && id != null && id !== '' ? String(labelOf(stored.provider, id) || '') : '';
    return text && text !== String(id) ? text : '';
  };
  return servedModelText(stored.model, catalogText) || catalogText(stored.colModel);
}

const cut = (s) => {
  const str = String(s || '');
  if (str.length <= SHARE_TEXT_MAX) return str;
  // Never leave half a surrogate pair at the cut.
  let end = SHARE_TEXT_MAX - CUT_MARK.length;
  const code = str.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return str.slice(0, end) + CUT_MARK;
};
/** An answer's state: failed (error line) > cut short (stalled / cut error) > complete. */
const stateOf = (turn) => (turn.errorText ? 'error' : turn.stalled || turn.cutError ? 'partial' : 'ok');
/**
 * An answer's timing as the share carries it (`{first, total?}` ms — the viewer's 「N초」): only for a
 * complete answer; a cut-short or failed one's clock says nothing about the model's speed.
 */
const timingOf = (turn) => {
  const ms = stateOf(turn) === 'ok' ? readTiming(turn.ms, SHARE_TIMING_MAX_MS) : null;
  return ms ? { ms } : {};
};
/**
 * How many IMAGES a stored marker stands for: its files (the first plus `more`) less its documents
 * (#1944 `docs`). A document is not counted as an image on a public card; its name is never sent.
 */
const imageCount = (img) => (img ? Math.min(SHARE_Q_IMAGES_MAX, Math.max(0, 1 + (Number.isInteger(img.more) ? img.more : 0) - docCountOf(img.docs, ATTACH_MAX_FILES))) : 0);
/**
 * The KIND of each file a stored marker stands for (ATTACH_KINDS — `att`, 2026-10-05): the icons a
 * reader tells a picture from a PDF from a Word file by. A marker from before `kinds` is rebuilt
 * from what it does hold — the first file's extension, the image count, the document count (the
 * documents past the first are 'file': their kind was never kept). Never a name.
 */
function attachKinds(img) {
  if (!img) return [];
  const files = 1 + (Number.isInteger(img.more) && img.more > 0 ? img.more : 0);
  const kept = attachKindsOf(img.kinds, files);
  if (kept.length) return kept.slice(0, SHARE_Q_IMAGES_MAX);
  let docs = docCountOf(img.docs, ATTACH_MAX_FILES);
  let images = Math.max(0, files - docs);
  docs = files - images;
  const out = [];
  const type = attachTypeOf({ name: typeof img.name === 'string' ? img.name : '' });
  const first = type ? attachKindOf(type) : '';
  if (first === ATTACH_KIND_IMAGE && images) { out.push(first); images -= 1; }
  else if (first && first !== ATTACH_KIND_IMAGE && docs) { out.push(first); docs -= 1; }
  for (; images > 0; images -= 1) out.push(ATTACH_KIND_IMAGE);
  for (; docs > 0; docs -= 1) out.push(ATTACH_KIND_FILE);
  return out.slice(0, SHARE_Q_IMAGES_MAX);
}
/** `{att}` for a marker with files, else `{}`. */
const attOf = (img) => { const att = attachKinds(img); return att.length ? { att } : {}; };
const roundKey = (turn) => (Number.isInteger(turn.round) ? turn.round : null);

/**
 * The snapshot for `entry`, or `{error}` when there is nothing shareable (no answer yet, more columns
 * than the server takes, a debate whose record names no one on it).
 *   opts.lang          'ko' | 'en' — the sharer's UI language (the page's fixed copy and meta)
 *   opts.title         the sharer's title ('' = the server uses the first question)
 *   opts.modelLabel    (colId, storedColumn) → display label of the column's model ('' = provider only)
 *   opts.aliasOf       (colId) → the debate name the page shows for that column ('' = none)
 *   opts.avatarOf      (colId) → the avatar emoji the page shows for that column ('' = the default
 *                      alias's emoji for the column's model)
 *   opts.summaryQuestion  the question shown for a summary round whose request has none
 *   opts.focus         where the share was started — compare {round: <entry round>, col?: colId}
 *                      · debate {col, round} (an AI's turn, as the column thread knows it),
 *                      {seq: <record seq>} or {topic: true}; mapped to snapshot indices here
 * Returns `{ snapshot, keyOf }` — keyOf maps a colId to its snapshot key (c1…) for the caller.
 */
export function buildShareSnapshot(entry, opts = {}) {
  if (!entry || typeof entry !== 'object' || !entry.columns) return { error: 'empty' };
  const lang = opts.lang === 'ko' ? 'ko' : 'en';
  const modelLabel = typeof opts.modelLabel === 'function' ? opts.modelLabel : (_id, c) => shareModelLabel(c, null);
  const aliasOf = typeof opts.aliasOf === 'function' ? opts.aliasOf : () => '';
  const avatarOf = typeof opts.avatarOf === 'function' ? opts.avatarOf : () => '';
  const record = entry.debate || null;
  // Debate: the cast in the record's order (debaters, then the moderator); compare: the entry's
  // columns that answered something, in the entry's (= page) order.
  const colIds = record
    ? [...record.debaters, ...(record.modCol ? [record.modCol] : [])].filter((id) => entry.columns[id])
    : Object.keys(entry.columns).filter((id) => (entry.columns[id].turns || []).some((turn) => turn.role === 'assistant'));
  if (!colIds.length) return { error: 'empty' };
  if (colIds.length > SHARE_COLUMNS_MAX) return { error: 'too_many_columns' };
  const keyOf = new Map(colIds.map((id, i) => [id, `c${i + 1}`]));
  const columns = colIds.map((id) => ({ key: keyOf.get(id), provider: entry.columns[id].provider, model: shareLabel(modelLabel(id, entry.columns[id]), SHARE_LABEL_MAX) }));
  const base = { v: SHARE_SNAPSHOT_VERSION, kind: record ? 'debate' : 'compare', lang, title: shareLabel(opts.title, SHARE_TITLE_MAX), columns };
  const emojiOf = (id, i) => avatarOf(id) || defaultAliasOf(entry.columns[id].provider, entry.columns[id].colModel, columns[i].model).emoji;
  const built = record ? debateBody(entry, record, keyOf, aliasOf, colIds.map(emojiOf), opts.focus) : compareBody(entry, colIds, keyOf, opts.summaryQuestion, opts.focus);
  if (built.error) return built;
  return { snapshot: { ...base, ...built.body, ...(built.focus ? { focus: built.focus } : {}) }, keyOf };
}

function compareBody(entry, colIds, keyOf, summaryQuestion, focusIn) {
  const roundIds = [];
  for (const id of colIds) for (const turn of entry.columns[id].turns || []) { const r = roundKey(turn); if (!roundIds.includes(r)) roundIds.push(r); }
  // A turn without a round (an entry from before provenance) belongs to the oldest group.
  roundIds.sort((a, b) => (a === null ? -1 : b === null ? 1 : a - b));
  const lowest = roundIds.find((r) => r !== null);
  const firstRound = Number.isInteger(entry.firstRound) ? entry.firstRound : lowest;
  const rounds = [];
  const indexOfRound = new Map();
  for (const r of roundIds) {
    const inRound = (id) => (entry.columns[id].turns || []).filter((turn) => roundKey(turn) === r);
    let summary = null;
    let judgeId = null;
    let userTurn = null;
    for (const id of colIds) {
      for (const turn of inRound(id)) {
        if (turn.role === 'assistant' && turn.kind === TURN_KIND_SUMMARY && !judgeId) judgeId = id;
        if (turn.role !== 'user') continue;
        if (turn.kind === TURN_KIND_SUMMARY && turn.summary) { summary = turn.summary; judgeId = id; }
        else if (!userTurn) userTurn = turn;
      }
    }
    const answers = {};
    const answerOf = (id) => {
      const said = inRound(id).filter((turn) => turn.role === 'assistant');
      return said.length ? said[said.length - 1] : null; // a retried round: its last answer
    };
    if (summary || judgeId) {
      const verdict = judgeId ? answerOf(judgeId) : null;
      if (!verdict) continue; // a request that never got its verdict says nothing on its own
      answers[keyOf.get(judgeId)] = { text: cut(verdict.text), state: stateOf(verdict), ...timingOf(verdict) };
      indexOfRound.set(r, rounds.length);
      // 🔴 Only the structure's question — never a user turn of this round (see the header).
      rounds.push({ q: cut((summary && summary.question) || summaryQuestion || ''), qImages: 0, answers, kind: 'summary', judge: keyOf.get(judgeId) });
      continue;
    }
    for (const id of colIds) { const a = answerOf(id); if (a) answers[keyOf.get(id)] = { text: cut(a.text), state: stateOf(a), ...timingOf(a) }; }
    if (!Object.keys(answers).length) continue; // a round with no answer in any column (all skipped)
    // The first SEND's question is the entry's, not a turn (history.js — the prompt card).
    const first = r === firstRound || (r === null && !userTurn);
    const q = userTurn ? userTurn.text : first ? entry.question : '';
    const img = userTurn ? userTurn.img : first ? entry.questionImg : null;
    indexOfRound.set(r, rounds.length);
    rounds.push({ q: cut(q), qImages: imageCount(img), ...attOf(img), answers });
  }
  if (!rounds.length) return { error: 'empty' };
  if (rounds.length > SHARE_ROUNDS_MAX) rounds.splice(0, rounds.length - SHARE_ROUNDS_MAX);
  let focus = null;
  if (focusIn && indexOfRound.has(focusIn.round)) {
    const idx = indexOfRound.get(focusIn.round) - (indexOfRound.size - rounds.length);
    if (idx >= 0) {
      const key = focusIn.col ? keyOf.get(focusIn.col) : undefined;
      if (!focusIn.col) focus = { round: idx };
      else if (key && rounds[idx].answers[key]) focus = { round: idx, col: key };
    }
  }
  return { body: { rounds }, focus };
}

function debateBody(entry, record, keyOf, aliasOf, emojis, focusIn) {
  // The words of an AI turn are in its column's turns, found by (column, round) — its last answer.
  const turnAt = (id, round) => {
    const turns = (entry.columns[id] && entry.columns[id].turns) || [];
    for (let i = turns.length - 1; i >= 0; i--) { const x = turns[i]; if (x.role === 'assistant' && x.round === round) return x; }
    return null;
  };
  const { transcript } = transcriptFromRecord(record, (id, round) => {
    const turn = turnAt(id, round);
    return turn ? (turn.errorText ? '' : turn.text) : null;
  });
  // The opening's files (#1961) ride the topic — the only debate turn that can carry any.
  const timeline = [{ who: 'user', role: 'speak', text: cut(entry.question), ...attOf(entry.questionImg) }];
  const indexOfSeq = new Map();
  const seqOfTurn = new Map(); // `${colId}|${round}` → record seq: a turn's share button knows only its column and round
  for (const e of transcript) {
    if (e.speaker === SPEAKER_USER) { indexOfSeq.set(e.seq, timeline.length); timeline.push({ who: 'user', role: 'speak', text: cut(e.text) }); continue; }
    const key = keyOf.get(e.speaker);
    const turn = turnAt(e.speaker, e.round);
    if (!key || !turn) continue; // a column the entry no longer holds / a turn the history bound evicted
    indexOfSeq.set(e.seq, timeline.length);
    seqOfTurn.set(`${e.speaker}|${e.round}`, e.seq);
    timeline.push({ who: key, role: e.role === ROLE_MODERATOR ? 'mod' : 'speak', text: cut(e.text), state: stateOf(turn), ...timingOf(turn) });
  }
  if (timeline.length < 2) return { error: 'empty' };
  if (timeline.length > SHARE_TIMELINE_MAX) timeline.splice(1, timeline.length - SHARE_TIMELINE_MAX); // keep the topic, drop the oldest
  const aliases = {};
  for (const [id, key] of keyOf) { const name = shareLabel(aliasOf(id), SHARE_ALIAS_MAX); if (name) aliases[key] = name; }
  const avatars = {};
  [...keyOf.values()].forEach((key, i) => { const emoji = shareAvatar(emojis[i]); if (emoji) avatars[key] = emoji; });
  const tone = record.tone && typeof record.tone.kind === 'string' ? record.tone.kind : null;
  let focus = null;
  const seq = focusIn && typeof focusIn.col === 'string' ? seqOfTurn.get(`${focusIn.col}|${focusIn.round}`) : focusIn && focusIn.seq;
  if (focusIn && focusIn.topic) focus = { t: 0 };
  else if (indexOfSeq.has(seq)) {
    const t = indexOfSeq.get(seq) - (indexOfSeq.size + 1 - timeline.length);
    if (t >= 1) focus = { t };
  }
  return { body: { debate: { aliases, avatars, mod: record.modCol ? keyOf.get(record.modCol) || null : null, tone, timeline } }, focus };
}
