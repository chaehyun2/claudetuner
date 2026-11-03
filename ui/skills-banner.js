// ui/skills-banner.js — claude.ai's own Skills page (Customize → Skills) gets one slim 「팀 스킬」 band (#2771 entry
// points): 「팀 스킬 둘러보기 ↗」 · 「내 스킬 팀에 공유 ↗」 · ✕. The place people think about skills is where the team's are.
//
// Shown only when the signed-in account's org has team skills (background `skill_orgs`, cached there), and closable for
// good (chrome.storage.local). Links only: it never reads or changes anything of the claude.ai account. The band lives in a
// shadow root (the site's CSS cannot reach it) and is put back when the SPA re-renders the page.
(() => {
  const HOST_ID = 'ct-skills-banner-host';
  const MSG = 'ct_prompts';                          // bg/prompts.js PROMPTS_MSG
  const PATH_RE = /^\/customize\/skills(\/|$)/;      // 탐색 · 내 항목 · a skill's page
  const HIDDEN_KEY = 'skillsBannerHidden';           // chrome.storage.local: closed with ✕
  const CHECK_MS = 1500;                             // SPA navigation / re-render check
  const REASK_TICKS = 20;                            // on the Skills page, ask the background again every ~30s (cached there)
  const ANCHOR_TEXT = 'Skills';                      // the page's visually hidden <h2> (same text in every UI language, 2026-11-02)
  const STR = {
    ko: { title: '팀 스킬', one: '{org} 팀원들이 나눈 스킬을 둘러보거나, 내가 만든 스킬을 팀에 공유하세요.', many: '팀원들이 나눈 스킬을 둘러보거나, 내가 만든 스킬을 팀에 공유하세요.', browse: '팀 스킬 둘러보기 ↗', share: '내 스킬 팀에 공유 ↗', close: '닫기 (다시 안 보기)' },
    en: { title: 'Team skills', one: 'Browse the skills your {org} teammates share, or share one you made.', many: 'Browse the skills your teammates share, or share one you made.', browse: 'Browse team skills ↗', share: 'Share my skill ↗', close: 'Close (do not show again)' },
  };
  const lang = /^ko/i.test(document.documentElement.lang || navigator.language || '') ? 'ko' : 'en';
  const t = (k) => STR[lang][k];

  // A re-injection (extension update, or a panel revive into a tab where this still runs) stops the previous instance in this
  // world — its timer and listener too, not only its band (Codex R1-B5) — and removes any band left in the page.
  const INSTANCE_KEY = '__ctSkillsBanner';
  try { if (globalThis[INSTANCE_KEY]) globalThis[INSTANCE_KEY].stop(); } catch { /* a dead instance */ }
  document.querySelectorAll('#' + HOST_ID).forEach((h) => h.remove());

  let orgs = null;        // null = not asked yet · [] = nothing to show
  let asking = false;
  let hidden = null;      // null = not read yet
  let timer = 0;
  let ticksSinceAsk = 0;
  let stopped = false;     // stop() ran (a newer instance took over): a late answer must not draw (R3 follow-up)
  let shownSent = false;   // GA banner_shown: once per visit to the Skills page
  let shownKey = '';       // the orgs the band on screen was built for — another answer rebuilds it (Codex R1-B2)
  const orgsKey = (list) => JSON.stringify((list || []).map((o) => [o.id, o.name]));

  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  const send = (msg) => new Promise((resolve) => {
    try { chrome.runtime.sendMessage({ type: MSG, ...msg }, (r) => { void chrome.runtime.lastError; resolve(r || null); }); } catch { resolve(null); }
  });
  const track = (src) => { send({ op: 'track', event: 'skills_entry', params: { site: 'claude', src } }); };

  /** Where the band goes: the Skills page's content column (the parent of its hidden 「Skills」 heading). */
  function anchorHeading() {
    return [...document.querySelectorAll('main h2')].find((h) => h.textContent.trim() === ANCHOR_TEXT) || null;
  }

  function build() {
    const host = document.createElement('div');
    host.id = HOST_ID;
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      .b { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 12px 0 4px; padding: 10px 12px;
           border: 1px solid rgba(13,148,136,.35); border-radius: 12px; background: rgba(13,148,136,.10); color: inherit;
           font: 13px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif; }
      .ico { flex: none; color: #14b8a6; }
      .txt { flex: 1 1 260px; min-width: 0; }
      .ttl { font-weight: 700; margin-right: 6px; }
      button { font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; border-radius: 8px; padding: 5px 10px;
               border: 1px solid rgba(13,148,136,.55); background: transparent; color: inherit; white-space: nowrap; }
      button:hover { background: rgba(13,148,136,.18); }
      button.x { border-color: transparent; padding: 4px 8px; opacity: .7; }
      button.x:hover { opacity: 1; }`;
    const box = document.createElement('div');
    box.className = 'b';
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', t('title'));
    box.innerHTML = '<svg class="ico" width="18" height="18" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="1.5" width="13" height="13" rx="3.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8.9 3.8 5.4 8.6h2.5l-.8 3.6 3.5-4.8H8.1z" fill="currentColor"/></svg>';
    const txt = document.createElement('div');
    txt.className = 'txt';
    const ttl = document.createElement('span');
    ttl.className = 'ttl';
    ttl.textContent = t('title');
    txt.appendChild(ttl);
    // The org name is server text: textContent only.
    txt.appendChild(document.createTextNode(orgs.length === 1 ? t('one').replace('{org}', orgs[0].name) : t('many')));
    // Only a real click: the page's own script can reach an open shadow root and must not open tabs through us (Codex R1-B1).
    const mk = (cls, text, onClick) => {
      const b = document.createElement('button'); b.type = 'button'; if (cls) b.className = cls; b.textContent = text;
      b.addEventListener('click', (e) => { if (e.isTrusted) onClick(); });
      return b;
    };
    const browse = mk('', t('browse'), () => { track('banner_browse'); send({ op: 'open_skills', from: 'banner' }); });
    const share = mk('', t('share'), () => { track('banner_share'); send({ op: 'open_skills_share' }); });
    const close = mk('x', '✕', () => {
      hidden = true;
      track('banner_close');
      try { chrome.storage.local.set({ [HIDDEN_KEY]: Date.now() }); } catch { /* context dead */ }
      host.remove();
    });
    close.setAttribute('aria-label', t('close'));
    close.title = t('close');
    box.append(txt, browse, share, close);
    root.append(style, box);
    return host;
  }

  function tick() {
    if (!alive()) { clearInterval(timer); document.querySelectorAll('#' + HOST_ID).forEach((h) => h.remove()); return; }
    const here = PATH_RE.test(location.pathname);
    const host = document.getElementById(HOST_ID);
    // Leaving the page forgets the answer: the next visit asks again (an account switch / logout is followed — Codex R1-B2).
    if (!here) { orgs = null; shownSent = false; if (host) host.remove(); return; }
    if (hidden !== false) { if (host) host.remove(); return; }
    if (!asking && (orgs === null || ++ticksSinceAsk >= REASK_TICKS)) {
      asking = true;
      ticksSinceAsk = 0;
      send({ op: 'skill_orgs' }).then((r) => { if (stopped) return; orgs = r && r.ok !== false && Array.isArray(r.orgs) ? r.orgs : []; asking = false; tick(); });
    }
    if (orgs === null) return;
    if (!orgs.length) { if (host) host.remove(); return; }
    const h = anchorHeading();
    if (!h || !h.parentElement) return;   // not rendered yet (or the page changed shape): try again next tick
    const key = orgsKey(orgs);
    if (host && host.isConnected && host.previousElementSibling === h && shownKey === key) return;
    if (host) host.remove();
    h.after(build());
    shownKey = key;
    if (!shownSent) { shownSent = true; track('banner_shown'); }
  }

  try {
    chrome.storage.local.get(HIDDEN_KEY, (o) => { void chrome.runtime.lastError; hidden = !!(o && o[HIDDEN_KEY]); tick(); });
  } catch { hidden = true; }
  // ✕ in another tab hides it here too.
  const onStorage = (changes, area) => {
    if (area === 'local' && changes[HIDDEN_KEY] && changes[HIDDEN_KEY].newValue) { hidden = true; tick(); }
  };
  try { chrome.storage.onChanged.addListener(onStorage); } catch { /* context dead */ }
  timer = setInterval(tick, CHECK_MS);
  globalThis[INSTANCE_KEY] = {
    stop() {
      stopped = true;
      clearInterval(timer);
      try { chrome.storage.onChanged.removeListener(onStorage); } catch { /* context dead */ }
      document.querySelectorAll('#' + HOST_ID).forEach((h) => h.remove());
    },
  };
})();
