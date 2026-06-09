// Popup announcements / notice banners, extracted from popup.js (refactor/popup-render).
// Leaf domain: imports shared state + escHtml; CT_CONFIG and i18n `t` are globals (classic scripts).
import { escHtml } from './util.js';
import { state } from './state.js';

const ANNOUNCEMENT_URL = CT_CONFIG.DEFAULT_SERVER_URL + '/api/announcements';
const PROMOS_URL = CT_CONFIG.DEFAULT_SERVER_URL + '/api/promos';

function _compareVersions(a, b) {
  // a >= b → true (semver: "1.7.2" >= "1.7.0")
  const pa = (a || '0').split('.').map(Number);
  const pb = (b || '0').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] || 0, vb = pb[i] || 0;
    if (va > vb) return true;
    if (va < vb) return false;
  }
  return true; // equal
}

function _sanitizeNoticeHtml(html) {
  if (!html) return '';
  const SITE = 'https://claudetuner.com';
  // DOM-based sanitizer: allow only a, br tags, remove the rest
  const doc = new DOMParser().parseFromString(html, 'text/html');
  function walk(node) {
    let out = '';
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += escHtml(child.textContent);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toLowerCase();
        if (tag === 'br') {
          out += '<br>';
        } else if (tag === 'a') {
          let href = child.getAttribute('href') || '#';
          if (href.toLowerCase().startsWith('javascript:')) href = '#';
          if (href.startsWith('/')) href = SITE + href;
          out += '<a href="' + escHtml(href) + '" target="_blank" rel="noopener">' + walk(child) + '</a>';
        } else {
          out += walk(child);
        }
      }
    }
    return out;
  }
  return walk(doc.body);
}

function _formatNoticeDate(dateStr) {
  if (!dateStr) return '';
  try { const d = new Date(dateStr); return (d.getMonth()+1) + '/' + d.getDate(); } catch(e) { return ''; }
}

const _noticeTypeMap = {
  info:     { cls: 'nb-info', icon: '\u2139\uFE0F', titleCls: 'nt-info' },
  warning:  { cls: 'nb-warning', icon: '\u26A0\uFE0F', titleCls: 'nt-warning' },
  critical: { cls: 'nb-critical', icon: '\uD83D\uDEA8', titleCls: 'nt-critical' }
};

// Allow only http(s) URLs; block javascript:/data: etc. Returns '' for unsafe values.
function _safeUrl(u) {
  if (!u) return '';
  const s = String(u).trim();
  return /^https?:\/\//i.test(s) ? s : '';
}

// Per-popup-load campaign→variant picks. In-memory only (not persisted), so each popup open
// re-randomizes which variant shows, while staying stable across re-renders within one open.
const _promoVariantChoices = {};

// Show a banner only to users in the target IANA timezone (e.g. 'Asia/Seoul').
// null/empty target = show to everyone. Catches Korea-resident users regardless of UI language.
function _matchesTz(tzTarget) {
  if (!tzTarget) return true;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone === tzTarget;
  } catch (e) {
    return true; // fail open if the browser can't report a timezone
  }
}

// Fire-and-forget impression/click beacon for CTR. Both kinds deduped per browser session via
// chrome.storage.session (survives popup reopen, unlike an in-memory Set), with a memory fallback.
const _evtSeen = new Set();
function _sendEvent(id, kind) {
  try {
    fetch(ANNOUNCEMENT_URL + '/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, kind }),
      keepalive: true
    }).catch(() => {});
  } catch (e) {}
}
function _trackEvent(id, kind) {
  if (!id) return;
  const memKey = kind + ':' + id;
  if (chrome.storage && chrome.storage.session) {
    const sk = 'ct_evt_' + kind + '_' + id;
    chrome.storage.session.get([sk], (r) => {
      if (r && r[sk]) return;
      chrome.storage.session.set({ [sk]: 1 });
      _sendEvent(id, kind);
    });
  } else {
    if (_evtSeen.has(memKey)) return;
    _evtSeen.add(memKey);
    _sendEvent(id, kind);
  }
}

// Variant selection: within each campaign, show one variant chosen at random.
// choices: { campaign -> chosen id } for this popup open (in-memory; keeps the pick stable across
// re-renders within one open). dismissed: array of dismissed ids. Returns { selected, updated }.
function _selectVariants(eligible, choices, dismissed, dismissedCampaigns) {
  const byCampaign = {}, singles = [];
  let updated = null;
  for (const n of eligible) {
    if (n.campaign) (byCampaign[n.campaign] = byCampaign[n.campaign] || []).push(n);
    else singles.push(n);
  }
  const out = singles.filter(n => !dismissed.includes(n.id));
  for (const camp of Object.keys(byCampaign)) {
    if (dismissedCampaigns.includes(camp)) continue; // whole campaign dismissed
    const grp = byCampaign[camp];
    const ids = grp.map(g => g.id).sort();
    let chosen = choices[camp];
    if (!chosen || ids.indexOf(chosen) === -1) {
      chosen = ids[Math.floor(Math.random() * ids.length)];
      updated = updated || {};
      updated[camp] = chosen;
    }
    const sel = grp.find(g => g.id === chosen);
    if (sel) out.push(sel);
  }
  return { selected: out, updated };
}

export async function loadPopupAnnouncements(attempt = 0) {
  try {
    const cacheBuster = Math.floor(Date.now() / 3600000);
    // Notices (/api/announcements) and ads (/api/promos) are separate endpoints — fetch both
    // and merge. (Keeping promos out of the announcements feed avoids leaking them into the
    // Claude sidebar / landing page, which consume /api/announcements as a notices list.)
    const [aRes, pRes] = await Promise.all([
      fetch(ANNOUNCEMENT_URL + '?t=' + cacheBuster),
      fetch(PROMOS_URL + '?t=' + cacheBuster).catch(() => null)
    ]);
    if (!aRes.ok) throw new Error('HTTP ' + aRes.status);
    const ann = await aRes.json();
    const promos = (pRes && pRes.ok) ? await pRes.json().catch(() => []) : [];
    const list = (Array.isArray(ann) ? ann : []).concat(Array.isArray(promos) ? promos : []);
    const extVer = chrome.runtime.getManifest().version;
    const userLang = getLang(); // 'ko' or 'en'
    state.popupNoticeList = list.filter(n => {
      // Only show if current extension version meets min_version requirement
      if (n.min_version && !_compareVersions(extVer, n.min_version)) return false;
      // Only show lang-specific announcements to matching language users
      if (n.lang && n.lang !== userLang) return false;
      // Only show timezone-targeted banners to matching users (e.g. Korea residents)
      if (!_matchesTz(n.tz)) return false;
      return true;
    });
    renderPopupNotices();
  } catch (e) {
    // The side panel can open before the network/SW is ready, so the first fetch
    // races and the bell never appears until the panel is reopened. Retry a few
    // times instead of silently giving up on the first failure.
    if (attempt < 3) setTimeout(() => loadPopupAnnouncements(attempt + 1), 800 * (attempt + 1));
  }
}

function renderPopupNotices() {
  const container = document.getElementById('ct-popup-notices');
  const promosEl = document.getElementById('ct-popup-promos');
  const toggleBtn = document.getElementById('notice-toggle-btn');
  const badge = document.getElementById('notice-badge');
  if (!container) return;

  chrome.storage.local.get({ ct_dismissed_notices: [], ct_dismissed_campaigns: [] }, (result) => {
    const dismissed = result.ct_dismissed_notices || [];
    const dismissedCampaigns = result.ct_dismissed_campaigns || [];
    const choices = _promoVariantChoices;
    // Collapse each campaign to one variant (random per popup open), then drop dismissed.
    const picked = _selectVariants(state.popupNoticeList, choices, dismissed, dismissedCampaigns);
    if (picked.updated) Object.assign(choices, picked.updated);
    const active = picked.selected;

    // Sort by newest first, then split: promos render in an always-visible container,
    // other notices stay behind the bell toggle.
    active.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const promos = active.filter(n => n.type === 'promo');
    const notices = active.filter(n => n.type !== 'promo');

    // Bell icon + badge reflect only dismissable notices (the ad is shown separately, always on)
    if (toggleBtn) {
      if (notices.length > 0) {
        toggleBtn.style.display = '';
        if (badge) { badge.textContent = notices.length; badge.style.display = 'flex'; }
      } else {
        toggleBtn.style.display = 'none';
        if (badge) badge.style.display = 'none';
      }
    }

    // Promo (ad) banners — always visible, non-dismissible (no close button)
    let promoHtml = '';
    for (const n of promos) {
      const ctaLabel = getLang() === 'en' ? 'Open →' : '바로가기 →';
      const pImg = _safeUrl(n.image_url);
      const pUrl = _safeUrl(n.url);
      const safeId = escHtml(n.id || '');
      promoHtml += '<div class="notice-banner nb-promo">';
      promoHtml += '<div class="promo-row">';
      if (pImg) promoHtml += '<img class="promo-logo" src="' + escHtml(pImg) + '" alt="" />';
      else promoHtml += '<span class="notice-icon" style="font-size:22px">✨</span>';
      // Popup is space-constrained — show the title only (drop the body). The dashboard
      // banner still renders the body via announcement.js.
      promoHtml += '<div class="promo-text">';
      promoHtml += '<div class="promo-title">' + escHtml(n.title || '') + '</div>';
      promoHtml += '</div>';
      if (pUrl) promoHtml += '<a class="promo-cta" data-url="' + escHtml(pUrl) + '" data-nid="' + safeId + '">' + ctaLabel + '</a>';
      promoHtml += '</div></div>';
    }

    // Regular notices — behind the bell, dismissable
    let html = '';
    for (const n of notices) {
      const t = _noticeTypeMap[n.type] || _noticeTypeMap.info;
      const dateStr = _formatNoticeDate(n.date);
      const hasBody = !!n.body;
      const safeId = escHtml(n.id || '');
      const nUrl = _safeUrl(n.url);
      html += '<div class="notice-banner ' + t.cls + '">';
      html += '<div class="notice-header" data-nid="' + safeId + '"' + (nUrl ? ' data-url="' + escHtml(nUrl) + '"' : '') + '>';
      html += '<span class="notice-icon">' + t.icon + '</span>';
      if (!nUrl && hasBody) html += '<span class="notice-chevron" id="chevron-' + safeId + '">\u25B6</span>';
      html += '<span class="notice-title ' + t.titleCls + '"' + (nUrl ? ' style="cursor:pointer"' : '') + '>' + escHtml(n.title || '') + (nUrl ? ' <span style="font-size:9px;opacity:0.5">\u2192</span>' : '') + '</span>';
      if (dateStr) html += '<span style="font-size:10px;color:var(--text-muted);margin-right:2px">' + dateStr + '</span>';
      html += '<button class="notice-close" data-nid="' + safeId + '">\u00D7</button>';
      html += '</div>';
      if (!nUrl && hasBody) html += '<div class="notice-body" id="nbody-' + safeId + '">' + _sanitizeNoticeHtml(n.body) + '</div>';
      html += '</div>';
    }
    if (promosEl) promosEl.innerHTML = promoHtml;
    container.innerHTML = html;
    const roots = [promosEl, container].filter(Boolean);

    // Header click: open Notion page if URL exists, otherwise toggle body
    roots.forEach(root => root.querySelectorAll('.notice-header').forEach(hdr => {
      hdr.addEventListener('click', (e) => {
        if (e.target.closest('.notice-close')) return;
        const url = hdr.dataset.url;
        if (url) {
          _trackEvent(hdr.dataset.nid, 'click');
          const sep = url.includes('?') ? '&' : '?';
          chrome.tabs.create({ url: url + sep + 'utm_source=extension' });
          return;
        }
        const nid = hdr.dataset.nid;
        const body = document.getElementById('nbody-' + nid);
        const chevron = document.getElementById('chevron-' + nid);
        if (!body) return;
        const isOpen = body.style.display === 'block';
        body.style.display = isOpen ? 'none' : 'block';
        if (chevron) chevron.classList.toggle('open', !isOpen);
      });
    }));

    // Promo CTA click: open partner URL in a new tab (target=_blank is unreliable in popups)
    roots.forEach(root => root.querySelectorAll('.promo-cta[data-url]').forEach(cta => {
      cta.addEventListener('click', (e) => {
        e.stopPropagation();
        const url = cta.dataset.url;
        if (!url) return;
        _trackEvent(cta.dataset.nid, 'click');
        const sep = url.includes('?') ? '&' : '?';
        chrome.tabs.create({ url: url + sep + 'utm_source=extension' });
      });
    }));

    // Close button event (notices only). Campaign banners dismiss by campaign key (not variant id).
    roots.forEach(root => root.querySelectorAll('.notice-close').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const nid = btn.dataset.nid;
        const n = state.popupNoticeList.find(x => x.id === nid);
        if (n && n.campaign) {
          chrome.storage.local.get({ ct_dismissed_campaigns: [] }, (r) => {
            const arr = r.ct_dismissed_campaigns || [];
            if (!arr.includes(n.campaign)) arr.push(n.campaign);
            chrome.storage.local.set({ ct_dismissed_campaigns: arr }, () => renderPopupNotices());
          });
        } else {
          chrome.storage.local.get({ ct_dismissed_notices: [] }, (r) => {
            const arr = r.ct_dismissed_notices || [];
            if (!arr.includes(nid)) arr.push(nid);
            chrome.storage.local.set({ ct_dismissed_notices: arr }, () => renderPopupNotices());
          });
        }
      });
    }));

    // Impression tracking for the variants actually shown (deduped per popup load)
    for (const n of active) _trackEvent(n.id, 'impression');

    // Keep the bell panel hidden when there are no notices (promos render separately, always on)
    if (notices.length === 0) container.style.display = 'none';
  });
}

