// ui/compare/share-card.js — the SHARE CARD (#1784 U6, docs/plans/compare-share.md §11.4 option C):
// the 1200×630 PNG a messenger shows for a PUBLIC share link, drawn here from the SAME snapshot the
// share dialog sent (share-snapshot.js output — never rebuilt) and uploaded by share.js after the
// server confirmed the author. Private shares never get a card (share.js never calls this).
//
// Two layers:
//   PURE  — cardPlainText / wrapLines / ellipsize / cardColumnName / cardAuthor / cardPlan decide
//           WHAT goes on the card (which round, which columns, which bubbles, the excerpt text) and
//           how text breaks, with the text measure injected. No DOM, no canvas:
//           test/compare-share-snapshot-probe.mjs runs them under Node.
//   DRAW  — renderShareCard paints a plan on an OffscreenCanvas (a document canvas as a fallback).
//           Flat colours and system fonts only, so the PNG stays far under the server's 500 KB cap;
//           a bigger blob, or any error, is `null` — a failed card never fails the share (the link
//           keeps the fixed og image).
// The avatar is fetched → Blob → createImageBitmap: a readable bitmap never taints the canvas (an
// <img> with a cross-origin src would make convertToBlob throw). Any failure → an initial circle.

import markdownit from '../../vendor-md/markdown-it.esm.min.mjs';
import { preClean } from '../md-render.js';
import { makeT } from '../compare-i18n.js';
import { PROVIDER_META } from './constants.js';
import { BRAND_MARK_PATHS, BRAND_WORDMARK } from './brand-marks.js';
import { shareLabel, SHARE_ALIAS_MAX } from './share-snapshot.js';

export const CARD_W = 1200;
export const CARD_H = 630;
/** The server's decoded-size cap (compare-shares image PUT) — a bigger PNG is not sent at all. */
export const CARD_MAX_BYTES = 512000;
/** Answer columns drawn side by side; the rest become a "+N" tile. */
export const CARD_COLUMNS_MAX = 3;
/** Debate bubbles drawn (the focused one first). */
export const CARD_BUBBLES_MAX = 3;
export const CARD_QUESTION_LINES = 2;
const AVATAR_TIMEOUT_MS = 4000;
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const ELLIPSIS = '…';
const BRAND_NAME = 'Claude Tuner';
// Mirrors compare.css body (Hangul needs the Korean system faces named).
const FONT_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', sans-serif";
// compare.css LIGHT tokens (a card is an image — it has no theme): --bg-body, --bg-card, --border,
// --text-primary, --text-secondary, --text-muted, --accent, --accent-light, --brand-*,
// --debate-ava-*, --debate-room-bg, --debate-room-fg, --debate-bubble-bg, --debate-notice-bg.
const COLOR = Object.freeze({
  bg: '#f6f6f8', card: '#ffffff', border: '#e5e7eb', text: '#1e1b4b', secondary: '#5b6472', muted: '#9ca3af',
  accent: '#4f46e5', accentLight: '#eef2ff', onAccent: '#ffffff',
  roomBg: '#b2c7d9', roomFg: '#2b3a48', bubble: '#ffffff', modBubble: '#d6e0ea',
  brand: { claude: '#d97757', gemini: '#4285f4', chatgpt: '#10a37f' },
  tile: { claude: '#fbe9e1', gemini: '#e3ecfd', chatgpt: '#dcf5ec' },
});
// Geometry (px). The question block, the content band and the brand strip never overlap.
const L = Object.freeze({
  pad: 56,
  pillY: 40, pillH: 32, pillFont: 17,
  qY: 90, qFont: 34, qLine: 44,
  bodyGap: 18, bodyBottom: 548, // the content band starts bodyGap under the question's last line
  stripY: 566, stripFont: 22, avatar: 38,
  colGap: 20, colPad: 20, mark: 30, labelFont: 20, textFont: 19, textLine: 29, moreW: 72,
  bubbleGap: 10, bubblePadY: 12, bubblePadX: 18, nameFont: 16, nameH: 22, bubbleText: 20, bubbleLine: 28, bubbleLinesMax: 8,
});

// ── PURE ─────────────────────────────────────────────────────────────────────────────────────────

const mdParser = markdownit({ html: false, linkify: false, breaks: true, typographer: false });
// With html:false a model's `<FollowUp …/>` suggestion tag is literal text — never card text.
const FOLLOWUP_TAG_RE = /<followup\b[^>]*>/gi;
const str = (v) => (typeof v === 'string' ? v : '');

function inlineText(children) {
  let out = '';
  for (const c of children || []) {
    if (c.type === 'text' || c.type === 'code_inline') out += c.content;
    else if (c.type === 'softbreak' || c.type === 'hardbreak') out += '\n';
  }
  return out;
}

/**
 * An answer's markdown → the words a reader sees, one block per line: headings, paragraphs and
 * list items as text (a list item keeps "• " / "1. "), a table row as its cells joined by " · ",
 * code as its lines. Emphasis, link targets, images and suggestion tags are gone; blank lines drop.
 */
export function cardPlainText(src) {
  const text = preClean(str(src)).replace(FOLLOWUP_TAG_RE, '');
  const lines = [];
  let bullet = '';
  let row = null;
  for (const tok of mdParser.parse(text, {})) {
    if (tok.type === 'list_item_open') bullet = tok.info ? `${tok.info}${tok.markup} ` : '• ';
    else if (tok.type === 'tr_open') row = [];
    else if (tok.type === 'tr_close') { if (row && row.some(Boolean)) lines.push(row.join(' · ')); row = null; }
    else if (tok.type === 'inline') {
      const s = inlineText(tok.children).trim();
      if (row) row.push(s);
      else if (s) { lines.push(bullet + s); bullet = ''; }
    } else if (tok.type === 'fence' || tok.type === 'code_block') lines.push(...tok.content.split('\n'));
  }
  return lines.map((l) => l.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean).join('\n');
}

/** `line` cut (by code point) until `line…` fits `maxWidth`. */
export function ellipsize(line, maxWidth, measure) {
  const cps = Array.from(str(line).trimEnd());
  while (cps.length && measure(cps.join('') + ELLIPSIS) > maxWidth) cps.pop();
  return cps.join('').trimEnd() + ELLIPSIS;
}

/**
 * `text` broken into lines no wider than `maxWidth` (by `measure(str) → px`), at most `maxLines`.
 * Breaks at spaces; a run wider than a line (CJK without spaces, a URL) breaks between code points.
 * Newlines are line breaks. When text is left over, the last line ends in "…" → `{lines, cut:true}`.
 */
export function wrapLines(text, maxWidth, measure, maxLines = Infinity) {
  const lines = [];
  const full = () => lines.length > maxLines;
  for (const para of str(text).split('\n')) {
    let line = '';
    const push = () => { lines.push(line.trimEnd()); line = ''; };
    for (const word of para.match(/\S+\s*/g) || []) {
      if (measure((line + word).trimEnd()) <= maxWidth) { line += word; continue; }
      if (line) { push(); if (full()) break; }
      if (measure(word.trimEnd()) <= maxWidth) { line = word; continue; }
      for (const ch of Array.from(word)) {
        if (!line || measure((line + ch).trimEnd()) <= maxWidth) { line += ch; continue; }
        push();
        if (full()) break;
        line = ch;
      }
      if (full()) break;
    }
    if (full()) break;
    if (line.trim()) push();
    if (full()) break;
  }
  if (lines.length <= maxLines) return { lines, cut: false };
  const kept = lines.slice(0, maxLines);
  if (kept.length) kept[kept.length - 1] = ellipsize(kept[kept.length - 1], maxWidth, measure);
  return { lines: kept, cut: true };
}

/** A column's name as the share page writes it: the service, then the model — never twice. */
export function cardColumnName(col) {
  const prov = (PROVIDER_META[col && col.provider] || {}).label || 'AI';
  const model = str(col && col.model).trim();
  if (!model) return prov;
  return model.toLowerCase().startsWith(prov.toLowerCase()) ? model : `${prov} ${model}`;
}

/** The server-confirmed author → `{name, photo}` for the corner, or null (anonymous / no name). */
export function cardAuthor(author) {
  if (!author || typeof author !== 'object' || (author.mode !== 'name' && author.mode !== 'name_photo')) return null;
  const name = shareLabel(author.name, SHARE_ALIAS_MAX);
  return name ? { name, photo: author.mode === 'name_photo' } : null;
}

const saidText = (a) => a && a.state !== 'error' && str(a.text).trim();

/**
 * WHAT the card shows, from a snapshot (+ its focus). null = nothing to draw.
 *   compare → {kind, question, columns:[{key, provider, label, text, state}], more, summary}
 *             the focused round (else the first); a focused column first; ≤3 columns, the rest "+N".
 *             A summary round shows its judge's verdict alone.
 *   debate  → {kind, question, bubbles:[{key, provider, name, mod, text}]}
 *             AI turns that said something, starting at the focused one (else the first), ≤3.
 */
export function cardPlan(snap, focus) {
  if (!snap || typeof snap !== 'object' || snap.v !== 1 || !Array.isArray(snap.columns)) return null;
  const byKey = new Map(snap.columns.filter((c) => c && typeof c.key === 'string').map((c) => [c.key, c]));
  if (snap.kind === 'compare' && Array.isArray(snap.rounds) && snap.rounds.length) {
    const ri = focus && Number.isInteger(focus.round) && snap.rounds[focus.round] ? focus.round : 0;
    const r = snap.rounds[ri] || {};
    const answers = r.answers && typeof r.answers === 'object' ? r.answers : {};
    const keys = [...byKey.keys()].filter((k) => answers[k] && typeof answers[k] === 'object');
    if (!keys.length) return null;
    const fk = focus && ri === focus.round && typeof focus.col === 'string' ? focus.col : null;
    if (fk && keys.includes(fk)) keys.unshift(...keys.splice(keys.indexOf(fk), 1));
    const shown = keys.slice(0, CARD_COLUMNS_MAX);
    const columns = shown.map((k) => {
      const a = answers[k];
      const state = a.state === 'error' || a.state === 'partial' ? a.state : 'ok';
      return { key: k, provider: byKey.get(k).provider, label: cardColumnName(byKey.get(k)), text: saidText(a) ? cardPlainText(a.text) : '', state };
    });
    const question = str(r.q).trim() || str(snap.title).trim() || str(snap.rounds[0].q).trim();
    return { kind: 'compare', question, columns, more: keys.length - shown.length, summary: r.kind === 'summary' };
  }
  if (snap.kind === 'debate' && snap.debate && Array.isArray(snap.debate.timeline) && snap.debate.timeline.length) {
    const tl = snap.debate.timeline;
    const aliases = snap.debate.aliases && typeof snap.debate.aliases === 'object' ? snap.debate.aliases : {};
    const isBubble = (it) => it && it.who !== 'user' && byKey.has(it.who) && saidText(it);
    const pick = (from) => {
      const out = [];
      for (let i = from; i < tl.length && out.length < CARD_BUBBLES_MAX; i++) if (isBubble(tl[i])) out.push(tl[i]);
      return out;
    };
    const start = focus && Number.isInteger(focus.t) && focus.t >= 1 && focus.t < tl.length ? focus.t : 1;
    let items = pick(start);
    if (!items.length && start > 1) items = pick(1);
    if (!items.length) return null;
    const bubbles = items.map((it) => {
      const col = byKey.get(it.who);
      const alias = str(aliases[it.who]).trim();
      return { key: it.who, provider: col.provider, name: alias || cardColumnName(col), mod: it.role === 'mod', text: cardPlainText(it.text) };
    });
    return { kind: 'debate', question: str(tl[0] && tl[0].text).trim() || str(snap.title).trim(), bubbles };
  }
  return null;
}

// ── DRAW ─────────────────────────────────────────────────────────────────────────────────────────

const font = (ctx, weight, size) => { ctx.font = `${weight} ${size}px ${FONT_STACK}`; };

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** A one-line text cut with "…" to `maxWidth`, drawn at (x, y) — returns its drawn width. */
function drawLine(ctx, text, x, y, maxWidth) {
  const measure = (s) => ctx.measureText(s).width;
  const line = measure(text) <= maxWidth ? text : ellipsize(text, maxWidth, measure);
  ctx.fillText(line, x, y);
  return measure(line);
}

function drawLines(ctx, text, x, y, maxWidth, lineH, maxLines) {
  const { lines } = wrapLines(text, maxWidth, (s) => ctx.measureText(s).width, maxLines);
  lines.forEach((line, i) => ctx.fillText(line, x, y + i * lineH));
  return lines.length;
}

/** The service mark in its avatar tile (brand-marks.js paths; a letter tile where there is none). */
function drawMark(ctx, provider, cx, cy, d) {
  ctx.fillStyle = COLOR.tile[provider] || COLOR.accentLight;
  ctx.beginPath(); ctx.arc(cx, cy, d / 2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = COLOR.brand[provider] || COLOR.accent;
  const path = BRAND_MARK_PATHS[provider];
  if (path && typeof Path2D === 'function') {
    const s = (d * 0.6) / 24; // the marks' viewBox is 24 wide
    ctx.save();
    ctx.translate(cx - 12 * s, cy - 12 * s);
    ctx.scale(s, s);
    ctx.fill(new Path2D(path));
    ctx.restore();
    return;
  }
  const word = BRAND_WORDMARK[provider] || ((PROVIDER_META[provider] || {}).label || 'AI').slice(0, 1);
  font(ctx, 800, Math.round(d * (word.length > 1 ? 0.3 : 0.45)));
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(word, cx, cy);
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
}

function drawHeader(ctx, plan, t) {
  const kind = plan.kind === 'debate' ? t('share_kind_debate') : t('share_kind_compare');
  font(ctx, 700, L.pillFont);
  const w = ctx.measureText(kind).width + 28;
  ctx.fillStyle = plan.kind === 'debate' ? COLOR.card : COLOR.accentLight;
  roundRect(ctx, L.pad, L.pillY, w, L.pillH, L.pillH / 2); ctx.fill();
  ctx.fillStyle = COLOR.accent;
  ctx.fillText(kind, L.pad + 14, L.pillY + (L.pillH - L.pillFont) / 2 - 1);
  font(ctx, 700, L.qFont);
  ctx.fillStyle = plan.kind === 'debate' ? COLOR.roomFg : COLOR.text;
  const used = drawLines(ctx, cardPlainText(plan.question).replace(/\n/g, ' '), L.pad, L.qY, CARD_W - 2 * L.pad, L.qLine, CARD_QUESTION_LINES);
  return L.qY + Math.max(1, used) * L.qLine + L.bodyGap; // a one-line question gives its room to the content
}

function drawColumns(ctx, plan, t, top) {
  const n = plan.columns.length;
  const moreW = plan.more > 0 ? L.moreW + L.colGap : 0;
  const colW = (CARD_W - 2 * L.pad - moreW - L.colGap * (n - 1)) / n;
  const h = L.bodyBottom - top;
  plan.columns.forEach((c, i) => {
    const x = L.pad + i * (colW + L.colGap);
    const y = top;
    ctx.fillStyle = COLOR.card; roundRect(ctx, x, y, colW, h, 14); ctx.fill();
    ctx.strokeStyle = COLOR.border; ctx.lineWidth = 1; ctx.stroke();
    drawMark(ctx, c.provider, x + L.colPad + L.mark / 2, y + L.colPad + L.mark / 2, L.mark);
    font(ctx, 700, L.labelFont);
    ctx.fillStyle = COLOR.text;
    const label = plan.summary ? `${c.label} · ${t('share_round_summary')}` : c.label;
    const lx = x + L.colPad + L.mark + 10;
    drawLine(ctx, label, lx, y + L.colPad + (L.mark - L.labelFont) / 2, x + colW - L.colPad - lx);
    const ty = y + L.colPad + L.mark + 14;
    const maxLines = Math.floor((y + h - L.colPad - ty) / L.textLine);
    const tw = colW - 2 * L.colPad;
    if (c.state === 'error' || !c.text) {
      font(ctx, 400, L.textFont); ctx.fillStyle = COLOR.muted;
      drawLines(ctx, t('share_state_error'), x + L.colPad, ty, tw, L.textLine, maxLines);
      return;
    }
    font(ctx, 400, L.textFont); ctx.fillStyle = COLOR.text;
    const used = drawLines(ctx, c.text, x + L.colPad, ty, tw, L.textLine, c.state === 'partial' ? maxLines - 1 : maxLines);
    if (c.state === 'partial') {
      ctx.fillStyle = COLOR.muted;
      drawLine(ctx, t('share_state_partial'), x + L.colPad, ty + used * L.textLine, tw);
    }
  });
  if (plan.more > 0) {
    const x = CARD_W - L.pad - L.moreW;
    ctx.fillStyle = COLOR.accentLight; roundRect(ctx, x, top, L.moreW, h, 14); ctx.fill();
    font(ctx, 800, 26); ctx.fillStyle = COLOR.accent;
    ctx.textAlign = 'center';
    ctx.fillText(`+${plan.more}`, x + L.moreW / 2, top + h / 2 - 13);
    ctx.textAlign = 'left';
  }
}

function drawBubbles(ctx, plan, t, top) {
  const n = plan.bubbles.length;
  const avail = L.bodyBottom - top - (n - 1) * L.bubbleGap;
  const chrome = 2 * L.bubblePadY + L.nameH + 4;
  const lines = Math.max(1, Math.min(L.bubbleLinesMax, Math.floor((avail / n - chrome) / L.bubbleLine)));
  const ax = L.pad + L.avatar / 2;
  const bx = L.pad + L.avatar + 14;
  const bw = CARD_W - L.pad - bx;
  let y = top;
  for (const b of plan.bubbles) {
    const tw = bw - 2 * L.bubblePadX;
    font(ctx, 400, L.bubbleText);
    const wrapped = wrapLines(b.text, tw, (s) => ctx.measureText(s).width, lines).lines;
    const bh = chrome + wrapped.length * L.bubbleLine;
    drawMark(ctx, b.provider, ax, y + L.avatar / 2, L.avatar);
    ctx.fillStyle = b.mod ? COLOR.modBubble : COLOR.bubble;
    roundRect(ctx, bx, y, bw, bh, 16); ctx.fill();
    font(ctx, 700, L.nameFont); ctx.fillStyle = COLOR.roomFg;
    drawLine(ctx, b.mod ? `${b.name} · ${t('debate_role_moderator')}` : b.name, bx + L.bubblePadX, y + L.bubblePadY + 2, tw);
    font(ctx, 400, L.bubbleText); ctx.fillStyle = COLOR.text;
    wrapped.forEach((line, i) => ctx.fillText(line, bx + L.bubblePadX, y + L.bubblePadY + L.nameH + 4 + i * L.bubbleLine));
    y += bh + L.bubbleGap;
  }
}

function drawAvatar(ctx, author, bitmap, cx, cy, d) {
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, d / 2, 0, Math.PI * 2); ctx.closePath();
  if (bitmap) {
    ctx.clip();
    const s = Math.max(d / bitmap.width, d / bitmap.height); // cover
    const w = bitmap.width * s;
    const h = bitmap.height * s;
    ctx.drawImage(bitmap, cx - w / 2, cy - h / 2, w, h);
  } else {
    ctx.fillStyle = COLOR.accentLight; ctx.fill();
    font(ctx, 800, Math.round(d * 0.46)); ctx.fillStyle = COLOR.accent;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText((Array.from(author.name)[0] || '?').toUpperCase(), cx, cy + 1);
  }
  ctx.restore();
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
}

/** The strip's feature name after the brand: the debate is not a cross-check. */
export function cardFeatureName(kind, t) {
  return kind === 'debate' ? t('heading_debate') : t('heading');
}

function drawStrip(ctx, plan, t, author, bitmap) {
  const h = CARD_H - L.stripY;
  ctx.fillStyle = COLOR.accent; ctx.fillRect(0, L.stripY, CARD_W, h);
  const ty = L.stripY + (h - L.stripFont) / 2 - 1;
  font(ctx, 800, L.stripFont); ctx.fillStyle = COLOR.onAccent;
  ctx.fillText(BRAND_NAME, L.pad, ty);
  const bw = ctx.measureText(BRAND_NAME).width;
  font(ctx, 500, L.stripFont);
  const feature = ` · ${cardFeatureName(plan.kind, t)}`;
  const brandEnd = L.pad + bw + ctx.measureText(feature).width;
  ctx.fillText(feature, L.pad + bw, ty);
  if (!author) return;
  font(ctx, 600, L.stripFont - 2);
  const label = t('share_card_by', author.name);
  const avatarW = author.photo ? L.avatar + 12 : 0;
  const maxW = CARD_W - L.pad - brandEnd - 40 - avatarW;
  const measure = (s) => ctx.measureText(s).width;
  const text = measure(label) <= maxW ? label : ellipsize(label, maxW, measure);
  const tx = CARD_W - L.pad - measure(text);
  ctx.fillStyle = COLOR.onAccent;
  ctx.fillText(text, tx, ty + 1);
  if (author.photo) drawAvatar(ctx, author, bitmap, tx - 12 - L.avatar / 2, L.stripY + h / 2, L.avatar);
}

/** fetch → Blob → ImageBitmap (never an <img>: a readable bitmap cannot taint the canvas). null on any failure. */
async function loadAvatar(url) {
  if (typeof url !== 'string' || !url.startsWith('https://') || typeof fetch !== 'function' || typeof createImageBitmap !== 'function') return null;
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ac ? setTimeout(() => ac.abort(), AVATAR_TIMEOUT_MS) : null;
  try {
    const res = await fetch(url, { credentials: 'omit', signal: ac ? ac.signal : undefined });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.size || blob.size > AVATAR_MAX_BYTES || !blob.type.startsWith('image/')) return null;
    return await createImageBitmap(blob);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function makeCanvas() {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(CARD_W, CARD_H);
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = CARD_W; c.height = CARD_H;
  return c;
}

function toPng(canvas) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/**
 * The card PNG for `snapshot` (the object the dialog sent), or null when there is nothing to draw,
 * the PNG would exceed CARD_MAX_BYTES, or anything fails.
 *   opts.author    the server-confirmed `{mode, name?}` (POST/PUT response) — 'anon' draws no corner
 *   opts.avatarUrl the share's avatar copy (https://claudetuner.com/c/<id>/avatar) for 'name_photo'
 *   opts.lang      'ko' | 'en' (default: the snapshot's)
 *   opts.focus     where the share opens (default: snapshot.focus)
 */
export async function renderShareCard(snapshot, opts = {}) {
  let bitmap = null;
  try {
    const plan = cardPlan(snapshot, opts.focus !== undefined ? opts.focus : snapshot && snapshot.focus);
    if (!plan) return null;
    const canvas = makeCanvas();
    const ctx = canvas && canvas.getContext('2d');
    if (!ctx) return null;
    const t = makeT((opts.lang || (snapshot && snapshot.lang)) === 'ko' ? 'ko' : 'en');
    const author = cardAuthor(opts.author);
    if (author && author.photo) bitmap = await loadAvatar(opts.avatarUrl);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillStyle = plan.kind === 'debate' ? COLOR.roomBg : COLOR.bg;
    ctx.fillRect(0, 0, CARD_W, CARD_H);
    const top = drawHeader(ctx, plan, t);
    if (plan.kind === 'debate') drawBubbles(ctx, plan, t, top);
    else drawColumns(ctx, plan, t, top);
    drawStrip(ctx, plan, t, author, bitmap);
    const blob = await toPng(canvas);
    return blob && blob.size > 0 && blob.size <= CARD_MAX_BYTES ? blob : null;
  } catch {
    return null;
  } finally {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
  }
}
