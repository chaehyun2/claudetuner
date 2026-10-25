// bg/prompts.js — the prompt picker's server proxy (#2038 in-page, docs/plans/prompt-inpage.md).
// The picker runs as a content script on claude.ai / chatgpt.com / gemini.google.com and cannot call
// the API itself (no host permission for api.claudetuner.com); it sends one message type here.
//
//   { type: 'ct_prompts', op, id?, body?, site?, lang? }  →  { ok, status, code?, data? }   (lang: store only, ko|en)
//   { type: 'ct_prompts', op: 'intro_claim' | 'intro_release', site }  →  { ok }   (the chip's once-per-site spotlight)
//
// 🔴 The ops are an ALLOW-LIST mapped to fixed method + path here — the content script never names a
// URL or method, so a page that manages to message us still reaches only these prompt routes.
// The server side is worker/src/routes/prompts.ts behind /api/ext (login-proven ext_token only).
import { getConfig, authedFetch } from './storage.js';
import { PROVIDER_LABELS, SITE_TAB_PATTERNS } from './constants.js';
import { SITE_ORIGINS } from '../vendor-ai/sites.js';
import { sendGAEvent } from './analytics.js';

export const PROMPTS_MSG = 'ct_prompts';
/** Where 「전체 보기」 and the login fallback go. */
export const PROMPTS_PAGE_URL = 'https://claudetuner.com/dashboard/prompts/';
const ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const SITES = ['claude', 'chatgpt', 'gemini'];
/** 추천 languages the server filters on (`GET …/prompt-store?lang=`); anything else = no filter. */
const STORE_LANGS = ['ko', 'en'];
/** chrome.storage.local, one key per site: the chip's first-visit spotlight was shown there. */
const INTRO_KEY_PREFIX = 'promptChipIntro_';
/** Spotlight claims are serialized here: check-and-mark per site with nothing in between (no compare-and-set in storage). */
let introChain = Promise.resolve();
export function introOp(message) {
  const site = SITES.includes(message.site) ? message.site : null;
  if (!site) return Promise.resolve({ ok: false });
  const key = INTRO_KEY_PREFIX + site;
  const run = introChain.then(async () => {
    if (message.op === 'intro_release') { await chrome.storage.local.remove(key); return { ok: true }; }
    const o = await chrome.storage.local.get(key);
    if (o[key]) return { ok: false };
    await chrome.storage.local.set({ [key]: Date.now() });
    return { ok: true };
  });
  introChain = run.catch(() => {});
  return run;
}

/** GA events the picker may ask us to send, with the only params each may carry. */
const TRACK_EVENTS = {
  prompt_picker_open: ['site', 'src'],
  prompt_insert: ['site', 'kind', 'result'],
  prompt_save: ['site', 'src', 'result'],
  prompt_delete: ['site'],
  prompt_intro: ['site', 'action'],
};

/** op → [method, path, needsId, sendsBody]. */
const OPS = {
  list: ['GET', '/api/ext/prompts', false, false],
  create: ['POST', '/api/ext/prompts', false, true],
  remove: ['DELETE', '/api/ext/prompts/:id', true, false],
  store: ['GET', '/api/ext/prompt-store', false, false],
  like: ['PUT', '/api/ext/prompt-store/:id/like', true, false],
  unlike: ['DELETE', '/api/ext/prompt-store/:id/like', true, false],
  use: ['POST', '/api/ext/prompt-store/:id/use', true, false],
  save: ['POST', '/api/ext/prompt-store/:id/save', true, false],
};

/** Only the fields a create may carry, as strings — the server validates lengths again. */
function createBody(body) {
  const b = body && typeof body === 'object' ? body : {};
  const source = SITES.includes(b.source) ? b.source : 'other';
  return { title: String(b.title || ''), body: String(b.body || ''), source };
}

/** Personal prompts get `sourceLabel` (where they were saved) — the picker shows it, and the names live in one place. */
function labelSources(data) {
  const label = (p) => (p && typeof p === 'object' && Object.hasOwn(PROVIDER_LABELS, p.source) ? { ...p, sourceLabel: PROVIDER_LABELS[p.source] } : p);
  if (Array.isArray(data?.prompts)) return { ...data, prompts: data.prompts.map(label) };
  if (data?.prompt) return { ...data, prompt: label(data.prompt) };
  return data;
}

async function callOp(message) {
  const spec = OPS[message.op];
  if (!spec) return { ok: false, status: 0, code: 'bad_op' };
  const [method, pathTpl, needsId, sendsBody] = spec;
  if (needsId && !ID_RE.test(String(message.id || ''))) return { ok: false, status: 0, code: 'bad_id' };
  const config = await getConfig().catch(() => null);
  if (!config?.serverUrl) return { ok: false, status: 0, code: 'no_config' };
  let path = needsId ? pathTpl.replace(':id', encodeURIComponent(message.id)) : pathTpl;
  if (message.op === 'store' && STORE_LANGS.includes(message.lang)) path += `?lang=${message.lang}`;
  const options = { method };
  if (sendsBody) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(createBody(message.body));
  }
  const resp = await authedFetch(config, `${config.serverUrl}${path}`, options);
  if (!resp) return { ok: false, status: 0, code: 'no_token' };
  const data = resp.status === 204 ? null : await resp.json().catch(() => null);
  if (!resp.ok) return { ok: false, status: resp.status, code: data?.code || data?.error || null, data };
  return { ok: true, status: resp.status, data: labelSources(data) };
}

/** Opens what lets the user sign in: the side panel when the browser allows it here, else the page. */
async function openLogin(sender) {
  try {
    if (chrome.sidePanel?.open && sender?.tab?.windowId != null) {
      await chrome.sidePanel.open({ windowId: sender.tab.windowId });
      return { ok: true };
    }
  } catch { /* needs a user gesture the message did not carry — fall through */ }
  await chrome.tabs.create({ url: PROMPTS_PAGE_URL });
  return { ok: true };
}

function track(message) {
  const allowed = TRACK_EVENTS[message.event];
  if (!allowed) return;
  const params = {};
  for (const k of allowed) if (typeof message.params?.[k] === 'string') params[k] = message.params[k].slice(0, 40);
  sendGAEvent(message.event, params).catch(() => {});
}

// ── 「Claude / ChatGPT / Gemini」 on our prompt pages → typed into that site's composer (#2584) ─────────
//
//   page → us (onMessageExternal):  { type: 'PROMPT_INSERT_CAPS' }  →  { ok, services: { claude, chatgpt, gemini } }
//                                   { type: 'OPEN_PROMPT_IN', service, text }  →  { ok, reason? }
//   us → the new tab:               { type: PROMPT_INSERT_MSG, text, url }  →  { ok, retry? }   (ui/prompt-picker.js)
//
// The page always copies first, so every failure here still leaves the text one paste away. Nothing is
// ever sent — the user reads it in the composer and presses send. 🔴 The URL is ours (never the page's),
// only the tab we just opened receives the text, and only while it is still on that URL (not a conversation
// the user went to meanwhile — checked here and again in the tab; back on it within the window, e.g. after
// signing in, it is delivered then). 🔴 Production origin only: every PR preview
// can run its own script, and none of them may type into the user's chat (Codex R1-B1).
export const PROMPT_INSERT_MSG = 'ct_prompts_insert';
/** Each site's new chat — the same pages as the site's own buttons (site/shared/prompt-use.js PROMPT_SERVICES). */
const PROMPT_SERVICE_URLS = {
  claude: `${SITE_ORIGINS.claude}/new`,
  chatgpt: `${SITE_ORIGINS.chatgpt}/`,
  gemini: `${SITE_ORIGINS.gemini}/app`,
};
const PROMPT_PAGE_ORIGIN = 'https://claudetuner.com';
const PROMPT_TEXT_MAX = 20000;                 // the prompt body cap (worker/src/routes/prompts.ts, LIMITS.body)
const PROMPT_OPEN_GAP_MS = 1000;               // one open per click — a page looping the message opens no tab storm
const PROMPT_DELIVER_EVERY_MS = 500;           // the composer appears after the site's own scripts
const PROMPT_DELIVER_FOR_MS = 20000;
let lastPromptOpenAt = 0;

/** The services whose composer our content script can reach: Claude always; ChatGPT / Gemini with their optional permission. */
async function promptInsertCaps() {
  const has = (p) => chrome.permissions.contains({ origins: [SITE_TAB_PATTERNS[p]] }).catch(() => false);
  const [chatgpt, gemini] = await Promise.all([has('chatgpt'), has('gemini')]);
  return { ok: true, services: { claude: true, chatgpt, gemini } };
}

/** The same page we opened (origin + path) — a tab the user moved on to another conversation is not ours to type into. */
function samePage(a, b) {
  try { const x = new URL(a), y = new URL(b); return x.origin === y.origin && x.pathname === y.pathname; } catch { return false; }
}

/** Keeps offering the text to the tab until its picker takes it (or says it cannot), or time runs out. */
function deliverPrompt(tabId, url, text) {
  const until = Date.now() + PROMPT_DELIVER_FOR_MS;
  const attempt = async () => {
    if (Date.now() > until) return;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;                                              // closed
    // Elsewhere (a sign-in page, another conversation): wait — typed in only once it is on that page again (R1-B3, R2-B1).
    if (!samePage(tab.url || '', url) && !samePage(tab.pendingUrl || '', url)) { setTimeout(attempt, PROMPT_DELIVER_EVERY_MS); return; }
    chrome.tabs.sendMessage(tabId, { type: PROMPT_INSERT_MSG, text, url }).then(
      (r) => { if (!r || r.retry) setTimeout(attempt, PROMPT_DELIVER_EVERY_MS); },
      () => setTimeout(attempt, PROMPT_DELIVER_EVERY_MS),          // no receiver yet (still loading)
    );
  };
  attempt();
}

async function openPromptIn(message, sender) {
  const url = PROMPT_SERVICE_URLS[message.service];
  const text = typeof message.text === 'string' ? message.text : '';
  if (!url || !text.trim() || text.length > PROMPT_TEXT_MAX) return { ok: false, reason: 'invalid' };
  const caps = await promptInsertCaps();
  if (!caps.services[message.service]) return { ok: false, reason: 'no_permission' };
  const now = Date.now();
  if (now - lastPromptOpenAt < PROMPT_OPEN_GAP_MS) return { ok: false, reason: 'busy' };
  lastPromptOpenAt = now;
  // Answered BEFORE the tab exists: the page waits only so long, and must never open its own tab as well (Codex R1-B2).
  const from = sender && sender.tab;
  chrome.tabs.create({
    url,
    ...(from && from.id != null ? { openerTabId: from.id, index: from.index + 1, windowId: from.windowId } : {}),
  }).then((tab) => deliverPrompt(tab.id, url, text), () => {});
  sendGAEvent('prompt_insert_web', { service: message.service }).catch(() => {});
  return { ok: true };
}

/** onMessageExternal: true when the message was ours (the answer comes through sendResponse). */
export function handlePromptExternal(message, sender, sendResponse) {
  if (!message || (message.type !== 'PROMPT_INSERT_CAPS' && message.type !== 'OPEN_PROMPT_IN')) return false;
  if (!sender || sender.origin !== PROMPT_PAGE_ORIGIN) { sendResponse({ ok: false, reason: 'origin' }); return false; }
  const run = message.type === 'PROMPT_INSERT_CAPS' ? promptInsertCaps() : openPromptIn(message, sender);
  run.then(sendResponse, () => sendResponse({ ok: false, reason: 'error' }));
  return true;
}

export function registerPromptsHandler() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== PROMPTS_MSG) return false;
    // Only our own content scripts and pages (never another extension or a web page).
    if (sender?.id !== chrome.runtime.id) return false;
    if (message.op === 'track') { track(message); return false; }
    if (message.op === 'open_page') { chrome.tabs.create({ url: PROMPTS_PAGE_URL }).catch(() => {}); return false; }
    if (message.op === 'intro_claim' || message.op === 'intro_release') {
      introOp(message).then(sendResponse, () => sendResponse({ ok: false }));
      return true;
    }
    if (message.op === 'open_login') { openLogin(sender).then(sendResponse, () => sendResponse({ ok: false })); return true; }
    callOp(message).then(sendResponse, () => sendResponse({ ok: false, status: -1, code: 'network' }));
    return true;
  });
}
