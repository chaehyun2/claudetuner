// Popup announcements / notice banners, extracted from popup.js (refactor/popup-render).
// Leaf domain: imports shared state + escHtml; CT_CONFIG and i18n `t` are globals (classic scripts).
import { escHtml } from './util.js';
import { state } from './state.js';

const ANNOUNCEMENT_URL = CT_CONFIG.DEFAULT_SERVER_URL + '/api/announcements';

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

export async function loadPopupAnnouncements(attempt = 0) {
  try {
    const cacheBuster = Math.floor(Date.now() / 3600000);
    const res = await fetch(ANNOUNCEMENT_URL + '?t=' + cacheBuster);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const list = await res.json();
    if (!Array.isArray(list)) return;
    const extVer = chrome.runtime.getManifest().version;
    const userLang = getLang(); // 'ko' or 'en'
    state.popupNoticeList = list.filter(n => {
      // Only show if current extension version meets min_version requirement
      if (n.min_version && !_compareVersions(extVer, n.min_version)) return false;
      // Only show lang-specific announcements to matching language users
      if (n.lang && n.lang !== userLang) return false;
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
  const toggleBtn = document.getElementById('notice-toggle-btn');
  const badge = document.getElementById('notice-badge');
  if (!container) return;

  chrome.storage.local.get({ ct_dismissed_notices: [] }, (result) => {
    const dismissed = result.ct_dismissed_notices || [];
    const active = state.popupNoticeList.filter(n => !dismissed.includes(n.id));

    // Header icon + badge
    if (toggleBtn) {
      if (state.popupNoticeList.length > 0) {
        toggleBtn.style.display = '';
        if (badge) {
          badge.textContent = active.length;
          badge.style.display = active.length > 0 ? 'flex' : 'none';
        }
      } else {
        toggleBtn.style.display = 'none';
      }
    }

    // Sort by newest first
    active.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    let html = '';
    for (const n of active) {
      const t = _noticeTypeMap[n.type] || _noticeTypeMap.info;
      const dateStr = _formatNoticeDate(n.date);
      const hasBody = !!n.body;
      const safeId = escHtml(n.id || '');
      html += '<div class="notice-banner ' + t.cls + '">';
      html += '<div class="notice-header" data-nid="' + safeId + '"' + (n.url ? ' data-url="' + escHtml(n.url) + '"' : '') + '>';
      html += '<span class="notice-icon">' + t.icon + '</span>';
      if (!n.url && hasBody) html += '<span class="notice-chevron" id="chevron-' + safeId + '">\u25B6</span>';
      html += '<span class="notice-title ' + t.titleCls + '"' + (n.url ? ' style="cursor:pointer"' : '') + '>' + escHtml(n.title || '') + (n.url ? ' <span style="font-size:9px;opacity:0.5">\u2192</span>' : '') + '</span>';
      if (dateStr) html += '<span style="font-size:10px;color:var(--text-muted);margin-right:2px">' + dateStr + '</span>';
      html += '<button class="notice-close" data-nid="' + safeId + '">\u00D7</button>';
      html += '</div>';
      if (!n.url && hasBody) html += '<div class="notice-body" id="nbody-' + safeId + '">' + _sanitizeNoticeHtml(n.body) + '</div>';
      html += '</div>';
    }
    container.innerHTML = html;

    // Header click: open Notion page if URL exists, otherwise toggle body
    container.querySelectorAll('.notice-header').forEach(hdr => {
      hdr.addEventListener('click', (e) => {
        if (e.target.closest('.notice-close')) return;
        const url = hdr.dataset.url;
        if (url) {
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
    });

    // Close button event
    container.querySelectorAll('.notice-close').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const nid = btn.dataset.nid;
        chrome.storage.local.get({ ct_dismissed_notices: [] }, (r) => {
          const arr = r.ct_dismissed_notices || [];
          if (!arr.includes(nid)) arr.push(nid);
          chrome.storage.local.set({ ct_dismissed_notices: arr }, () => renderPopupNotices());
        });
      });
    });

    // Auto-close panel if no active announcements
    if (active.length === 0) {
      container.style.display = 'none';
    }
  });
}

