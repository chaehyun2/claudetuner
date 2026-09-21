// Claude Tuner — per-question 「…에도 물어보기」 rows under every user message bubble (#1452).
//
// ONE implementation for claude.ai (input-usage.js) and chatgpt.com (chatgpt-input.js): the row,
// its ask button, its gear, the instance ownership and the write-only-on-difference relabel used
// to live in input-usage.js alone; a second hand-edited copy for chatgpt.com is exactly the
// duplication CLAUDE.md forbids, so the site-independent part moved here. What DIFFERS per site
// (which element is the bubble, where its row goes, how the row finds its bubble again, what the
// question text is) comes in through `create(opts)` from the calling strip.
//
// Classic script, no imports, no usage-shared core: loaded BEFORE the strip that calls it
// (manifest content_scripts on claude.ai, bg/providers.js CHATGPT_INJECT on chatgpt.com) and
// exposed as `globalThis.__ctCmpMsgRows`. The strips treat it as a SOFT dependency (#1421): a
// stale/absent copy leaves `__ctCmpMsgRows` undefined and the rows are simply off — the composer
// strip and its own compare button never depend on this file.
//
// create(opts) → { sync(), removeAll() }
//   opts.document, opts.chrome   — the page's globals (passed in, never read from the closure, so
//                                  the harness can hand in a fake pair)
//   opts.provider                — 'claude' | 'chatgpt' → OPEN_COMPARE.src
//   opts.bubbleSelector          — matches every user message bubble
//   opts.anchorOf(bubble)        — { parent, before } where the row is inserted
//                                  (insertBefore(row, before); before:null = append), or null to skip
//   opts.rowOwnerOf(row)         — the bubble a row belongs to, looked up from the row's CURRENT
//                                  position (null = orphan → the row is removed)
//   opts.readText(bubble)        — the question text sent as OPEN_COMPARE.q
//   opts.t(key)                  — the strip's i18n ('cmp_ask_others', 'cmp_msg_tip', 'settings')
//   opts.gen()                   — the calling instance's generation token
//   opts.isCurrent()             — true while the calling instance is the newest one on the page
//   opts.allowed()               — flag && compareEnabled && compareMsgButtonEnabled
//   opts.gearIconPath            — optional override of GEAR_ICON_PATH (the strips reuse ours)
(() => {
  'use strict';

  // Gear glyph (Feather "settings"). Single source for the row gears here AND the strips' own
  // `.ct-settings` / `.ct-cg-strip-gear` buttons (they read `__ctCmpMsgRows.GEAR_ICON_PATH` and
  // keep a local copy only as the #1421 fallback), so the glyphs never drift.
  const GEAR_ICON_PATH = 'M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z';

  // Class names are shared with input-usage.css / chatgpt-usage.css and the guards — keep them.
  const ROW_CLASS = 'ct-cmp-msg';
  const BTN_CLASS = 'ct-cmp-msg-btn';
  const STRIP_BTN_CLASS = 'ct-cmp-btn'; // the row button shares the strip button's base class
  const GEAR_CLASS = 'ct-cmp-msg-gear';
  // Which instance built a row: a row from an older injection carries a click handler bound to a
  // runtime that may be dead (Codex 1R #1) — the newest instance rebuilds it instead of reusing it.
  const GEN_ATTR = 'data-ct-cmp-gen';
  // The gear opens the options page at the cross-check card (background OPEN_OPTIONS →
  // options.html#<hash>), so the rows can be switched off from where they appear.
  const GEAR_HASH = 'compare-enabled-row';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function create(opts) {
    const { document, chrome, provider, bubbleSelector, anchorOf, rowOwnerOf, readText, t, gen, isCurrent, allowed } = opts;
    const gearPath = opts.gearIconPath || GEAR_ICON_PATH;

    /** The row's gear: a 12px SVG (no innerHTML — the row is light DOM) that opens the options page. */
    function buildGear(settingsLabel) {
      const gear = document.createElement('button');
      gear.type = 'button';
      gear.className = GEAR_CLASS;
      gear.title = settingsLabel;
      gear.setAttribute('aria-label', settingsLabel);
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '2');
      svg.setAttribute('aria-hidden', 'true');
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', '12'); circle.setAttribute('cy', '12'); circle.setAttribute('r', '3');
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', gearPath);
      svg.appendChild(circle); svg.appendChild(path);
      gear.appendChild(svg);
      gear.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        try { chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS', hash: GEAR_HASH }); } catch { /* context dead */ }
      });
      return gear;
    }

    function buildRow(label, tip, settingsLabel) {
      const row = document.createElement('div');
      row.className = ROW_CLASS;
      row.setAttribute(GEN_ATTR, String(gen()));
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = STRIP_BTN_CLASS + ' ' + BTN_CLASS;
      btn.textContent = label;
      btn.title = tip;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // The bubble is looked up at click time, not captured: the site may swap the bubble node
        // in place (an edited question) while our row stays — the row's current owner is the
        // question the user sees (Codex 1R #1).
        const b = rowOwnerOf(row);
        const q = b ? readText(b) : '';
        try { chrome.runtime.sendMessage({ type: 'OPEN_COMPARE', src: provider, q, placement: 'message' }); } catch { /* context dead */ }
      });
      row.appendChild(btn);
      row.appendChild(buildGear(settingsLabel));
      return row;
    }

    /** Follow a language change on an existing row. Write only on a difference so a settled page
     *  produces no DOM mutation (the caller's observer would tick again) (Codex 1R #2 / 2R). */
    function relabel(row, label, tip, settingsLabel) {
      const b = row.querySelector('.' + BTN_CLASS);
      if (b && b.textContent !== label) b.textContent = label;
      if (b && b.title !== tip) b.title = tip;
      const g = row.querySelector('.' + GEAR_CLASS);
      if (g && g.title !== settingsLabel) { g.title = settingsLabel; g.setAttribute('aria-label', settingsLabel); }
    }

    function removeAll() {
      document.querySelectorAll('.' + ROW_CLASS).forEach((r) => r.remove());
    }

    /** One row per bubble, owned by the newest instance. Idempotent: called from every observer
     *  tick and after every strip render, never from a timer of its own. */
    function sync() {
      // A superseded instance keeps getting ticks while the runtime is alive; it must neither add
      // nor remove rows — the newest instance owns them (Codex 2R #26).
      if (!isCurrent()) return;
      if (!allowed()) { removeAll(); return; }
      const mine = String(gen());
      // A row whose bubble is gone (message deleted / re-rendered) goes, so does a row another
      // instance built (its handler may point at a dead runtime), and so does a second row on
      // the same bubble — the loop below rebuilds what is missing.
      const owned = new Map();
      document.querySelectorAll('.' + ROW_CLASS).forEach((row) => {
        const bubble = rowOwnerOf(row);
        if (!bubble || row.getAttribute(GEN_ATTR) !== mine || owned.has(bubble)) { row.remove(); return; }
        owned.set(bubble, row);
      });
      const label = t('cmp_ask_others');
      const tip = t('cmp_msg_tip');
      const settingsLabel = t('settings');
      document.querySelectorAll(bubbleSelector).forEach((bubble) => {
        const existing = owned.get(bubble);
        if (existing) { relabel(existing, label, tip, settingsLabel); return; }
        const at = anchorOf(bubble);
        if (!at || !at.parent) return;
        at.parent.insertBefore(buildRow(label, tip, settingsLabel), at.before || null);
      });
    }

    return { sync, removeAll };
  }

  globalThis.__ctCmpMsgRows = { create, GEAR_ICON_PATH };
})();
