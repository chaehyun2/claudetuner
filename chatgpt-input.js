// Claude Tuner — ChatGPT Input Usage Strip
// Injects a single compact usage line as a full-width row directly BELOW the
// composer box (a sibling of the composer form, like claude.ai's usage row).
// This avoids fighting the composer's internal CSS grid (which moves/auto-places
// items between its default and expanded templates). Falls back to a line above
// the bottom disclaimer ("ChatGPT can make mistakes...") if the form isn't found.

(() => {
  'use strict';

  const CORE = globalThis.__ctUsageCore;
  if (!CORE) return; // usage-shared.js must load first

  // Generation token: each (re)injection bumps it; only the newest instance is
  // current. Stale instances (after extension update / dev reload) detect the
  // mismatch and tear down, so re-injection always takes over cleanly.
  const _gen = (globalThis.__ctCgInputGen = (globalThis.__ctCgInputGen || 0) + 1);
  const isCurrent = () => _gen === globalThis.__ctCgInputGen && CORE.isContextValid();

  const STRIP_ID = 'ct-cg-strip';
  const SITE_URL = 'https://claudetuner.com';
  const CONTACT_URL = 'https://tally.so/r/q4dyQk'; // shared feedback/inquiry form (same as popup)
  const MOUNT_INTERVAL_MS = 1000;
  const COUNTDOWN_INTERVAL_MS = 1000;
  const REFRESH_INTERVAL_MS = 60000;
  const PROVIDER = 'chatgpt';

  // ── State ──
  let _enabled = null;
  let _mounted = false;
  let _data = null;
  let _lang = 'en';
  let _intervals = [];
  let _name = '';  // account name/email for prefilling the inquiry form
  let _email = '';

  // Tally inquiry form prefill (same field keys as the dashboard error-report).
  function contactUrl() {
    if (!_name && !_email) return CONTACT_URL;
    const p = new URLSearchParams();
    if (_name) p.set('user_name', _name);
    if (_email) p.set('user_email', _email);
    return `${CONTACT_URL}?${p.toString()}`;
  }

  function loadAccount() {
    try {
      chrome.storage.local.get(['accountCache', 'independentAccount'], (r) => {
        if (!isCurrent()) return;
        const a = r.accountCache || {};
        const ia = r.independentAccount || {};
        _name = a.name || ia.name || '';
        _email = a.email || ia.email || '';
        renderStrip(); // refresh the prefilled href
      });
    } catch { /* context dead */ }
  }

  const I18N = {
    ko: { session: '5시간 사용률', weekly: '주간 사용률', no_data: '수집 중...', reset_soon: '곧 리셋', est_reset: '리셋 시 예상', settings: '설정', contact: '문의하기', cmp_ask_others: 'Claude·Gemini에도 물어보기', cmp_ask_others_tip: '같은 질문을 다른 AI에게도 보내 답을 교차 검증해요 (AI 크로스체크)', cmp_msg_tip: '이 질문을 Claude·Gemini에도 보내 답을 교차 검증해요 (AI 크로스체크)' },
    en: { session: '5-hour usage', weekly: 'Weekly usage', no_data: 'Collecting...', reset_soon: 'Resetting soon', est_reset: 'est. at reset', settings: 'Settings', contact: 'Feedback', cmp_ask_others: 'Ask Claude & Gemini too', cmp_ask_others_tip: 'Send the same question to other AIs and cross-check the answers (AI Cross-Check)', cmp_msg_tip: 'Send this question to Claude & Gemini too and cross-check the answers (AI Cross-Check)' },
  };
  function t(key) { return (I18N[_lang] || I18N.en)[key] || I18N.en[key] || key; }

  // Clear reset wording (with a clock icon), mirroring claude.ai: "⏱ 1h 54m 뒤 리셋"
  // (ko) / "⏱ resets in 1h 54m" (en).
  function resetLabel(resetAt) {
    const diff = new Date(resetAt).getTime() - Date.now();
    if (diff <= 0) return `⏱ ${t('reset_soon')}`;
    const time = CORE.formatCountdown(resetAt, _lang).replace(/^⏱\s*/, '');
    return _lang === 'ko' ? `⏱ ${time} 뒤 리셋` : `⏱ resets in ${time}`;
  }

  // ── Anchor ──
  // Preferred: a full-width row directly below the composer box (sibling of the
  // composer form). Fallback: just above the bottom disclaimer line.
  //
  // 🔴 THE FORM'S PARENT DOES NOT LAY ANYTHING OUT. It is `display: contents`, so inserting after
  // the form actually drops the strip into the GRANDPARENT — the composer container, whose height
  // is pinned by `--composer-container-height`. That box cannot grow for us. In Chat mode it holds
  // only the form, so our overflow lands on empty page and looks fine; that has always been luck,
  // not design.
  function displayOf(node) {
    const cs = getComputedStyle(node);
    return cs ? cs.display : '';   // getComputedStyle returns null for a node in a dead document
  }

  function composerBox(form) {
    let el = form.parentElement;
    while (el && displayOf(el) === 'contents') el = el.parentElement;
    // 🔴 NEVER HAND BACK THE DOCUMENT SHELL. The walk stops at the first ancestor that lays out,
    // and on a page where every wrapper is `display: contents` that is BODY — inserting "after
    // BODY" drops the strip at the very bottom of the document, which is worse than the overlap
    // this whole change exists to fix. No composer, no outside anchor (Codex, #1491 finding 3).
    if (!el || el === document.body || el === document.documentElement) return null;
    return el;
  }

  // 🔴 Is something OTHER than the composer already occupying the space below it? In Work mode
  // ChatGPT puts its own row there (프로젝트 / 파일 / 플러그인 / 데스크톱 앱 다운로드) as a
  // sibling of the form inside that same height-pinned box — so our strip and that row are squeezed
  // into one slot and overlap. Measured on 2026-09-17: strip at y=438 h=23, row at y=441 h=64,
  // **20px of overlap**, and the row's own wrapper is opaque with `overflow-clip`, so it paints over
  // us. That is the reported breakage: the gauge and the compare button peek out from behind a
  // white card.
  //
  // 🪤 This asks about STRUCTURE, not about "Work mode". We do not own ChatGPT's mode names and a
  // second row could arrive under any other label; the thing that actually breaks us is "the
  // composer box already lays out content below the form", which is directly observable.
  function boxHasContentBelowForm(box, form) {
    if (!box) return false;
    const formBottom = form.getBoundingClientRect().bottom;
    const flat = [];
    (function walk(node) {
      for (const child of node.children) {
        // Our own strip stays in the list — the displacement maths below needs its position and
        // height — but it is never itself a candidate.

        if (getComputedStyle(child).display === 'contents') walk(child);
        else flat.push(child);
      }
    })(box);
    // 🔴 DISCOUNT OUR OWN DISPLACEMENT, or the answer depends on the thing it decides. While the
    // strip is mounted INSIDE this box it sits between the form and everything below it, pushing
    // those elements down by exactly its own height. Measuring them as-is makes a row that is
    // genuinely above the threshold look below it once we leave — so the tick would unmount, the
    // next mount() would remeasure without the strip, choose the old anchor again, and churn the
    // node every second forever (Codex, #1491 finding 4).
    const self = flat.find((el) => el.id === STRIP_ID);
    const selfIndex = self ? flat.indexOf(self) : -1;
    const selfHeight = self ? self.getBoundingClientRect().height : 0;

    return flat.some((el, i) => {
      if (el === form || form.contains(el)) return false;
      if (el === self) return false;
      const cs = getComputedStyle(el);
      // Out-of-flow siblings cannot squeeze us — the `top-full z-[-1]` panel next to the form is
      // absolutely positioned and measures 0 high in both modes.
      if (!cs || cs.position === 'absolute' || cs.position === 'fixed') return false;
      const r = el.getBoundingClientRect();
      const shift = (selfIndex >= 0 && i > selfIndex) ? selfHeight : 0;
      // >4px filters the `sr-only` 1px announcers that sit beside the form in both modes.
      return r.height > 4 && (r.bottom - shift) > formBottom + 1;
    });
  }

  // The composer form. 2026-09-26 chatgpt.com UI (Chat/Work tabs): `form[data-chatgpt-composer]`
  // (with `data-composer-placement="home"|"thread"`); the `data-type="unified-composer"` shape it
  // replaced is kept as a fallback in case the rollout is A/B. Single source for every lookup here.
  const COMPOSER_FORM_SELECTOR = 'form[data-chatgpt-composer], form[data-type="unified-composer"]';

  /** The composer form, preferring a laid-out one if the page ever holds several; null if none. */
  function findComposerForm() {
    const forms = Array.from(document.querySelectorAll(COMPOSER_FORM_SELECTOR));
    return forms.find((f) => f.getClientRects().length > 0) || forms[0] || null;
  }

  function findAnchor() {
    const form = findComposerForm();
    if (form && form.parentNode) {
      const box = composerBox(form);
      // Put the strip BELOW the whole composer container when that container is already full.
      // Verified in page on 2026-09-17: overlap 20px → 0px, and the strip sits below the box.
      if (box && box.parentNode && boxHasContentBelowForm(box, form)) {
        return { type: 'belowcontainer', el: box };
      }
      return { type: 'belowbox', el: form };
    }
    const disclaimer = findDisclaimer();
    if (disclaimer && disclaimer.parentNode) return { type: 'disclaimer', el: disclaimer };
    return null;
  }

  function findDisclaimer() {
    const candidates = document.querySelectorAll('div[class*="min-h-8"][class*="text-xs"]');
    for (const el of candidates) {
      const cls = el.className || '';
      if (cls.includes('w-full') && cls.includes('justify-center') &&
          !el.closest('nav') && !el.closest('#stage-sidebar-tiny-bar')) {
        return el;
      }
    }
    return null;
  }

  // ── Build ──
  function buildStrip() {
    const strip = document.createElement('div');
    strip.id = STRIP_ID;
    strip.className = 'ct-cg-strip';
    renderStripInto(strip);
    return strip;
  }

  // `title` is optional; when present it is escaped into the attribute. The escaper turns a double
  // quote into &quot;, so a locale string containing one cannot close the attribute early and
  // truncate the tooltip — the failure #1209 had to guard against on the dashboard.
  function seg(text, color, title) {
    const attrs = (color ? ` style="color:${color}"` : '')
      + (title ? ` title="${CORE.escapeHtml(title)}"` : '');
    const s = `<span class="ct-cg-strip-seg"${attrs}>${CORE.escapeHtml(text)}</span>`;
    return s;
  }

  // A label + percent followed by a compact inline gauge bar (current fill +
  // optional prediction marker), mirroring the claude.ai input strip.
  // 🔴 The label carries the same "excludes text chat" note as the sidebar panel, from the same
  // CORE string. Both are injected into chatgpt.com together (background.js CHATGPT_INJECT) and
  // render the SAME percentage; noting one and not the other is worse than noting neither, because
  // the user compares the two and reads the bare one as "so THIS is the chat gauge". This strip's
  // label is the weaker of the two — "주간 사용률" / "Weekly usage" is a bare claim with nothing
  // qualifying it.
  //
  // ⚠️ A native title= does not open on touch (the constraint that made the dashboard's note a real
  // <button> in #1209). Accepted here rather than worked around: this is a one-line composer strip
  // with no room for an inline note, and it already uses title= for its reset cell, so the
  // affordance is at least consistent. The sidebar panel on the same page carries the full note.
  function metric(label, util, predUtil) {
    const color = CORE.gaugeColor(util);
    const clamped = Math.min(util, 100);
    const showPred = predUtil != null && predUtil - util >= CORE.PRED_MIN_DELTA;
    const predColor = showPred ? CORE.gaugeColor(predUtil) : null;
    const clampedPred = showPred ? Math.min(predUtil, 100) : 0;
    // Prediction fill (diagonal stripe) lives inside the clipped track between the
    // current fill and the predicted level; the marker sits on top of the bar.
    let bar = `<span class="ct-cg-strip-bar"><span class="ct-cg-strip-bar-track"><span class="ct-cg-strip-bar-fill" style="width:${clamped}%;background:${color}"></span>`;
    if (showPred) {
      bar += `<span class="ct-cg-strip-bar-pred-fill" style="left:${clamped}%;width:${clampedPred - clamped}%;color:${predColor}"></span>`;
    }
    bar += `</span>`;
    if (showPred) {
      bar += `<span class="ct-cg-strip-bar-marker" style="left:${clampedPred}%;background:${predColor}"></span>`;
    }
    bar += `</span>`;
    const note = CORE.cgUsageNote ? CORE.cgUsageNote(_lang) : '';
    return seg(`${label} ${Math.round(util)}%`, color, note) + bar;
  }

  // Gear glyph (Feather "settings"). Canonical copy = ui/cmp-msg-rows.js GEAR_ICON_PATH (the
  // per-question row's gear draws it from there); the literal is the #1421 fallback for a load
  // without that shared script, and test/compare-button-guard.mjs asserts the two are identical.
  const GEAR_ICON_PATH = (globalThis.__ctCmpMsgRows && globalThis.__ctCmpMsgRows.GEAR_ICON_PATH) || 'M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z';
  const GEAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="' + GEAR_ICON_PATH + '"/></svg>';
  // Chat-bubble icon (matches the popup's Feedback button).
  const CONTACT_SVG = '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zm-4 0H9v2h2V9z" clip-rule="evenodd"/></svg>';

  // The button may not cost the strip a line (CORE.fitCompareButton): measured on every mount and
  // again whenever the strip's width changes. Guarded for a tab whose usage-shared.js predates
  // these helpers (dynamic re-injection, #1421) — then the button simply behaves as before.
  let _fitStop = null;
  let _fitTarget = null;
  function ensureCompareFit(strip) {
    if (!CORE || !CORE.fitCompareButton) return;
    // A superseded instance's observer answers null → no-op on the newest instance's button.
    const find = () => (isCurrent() ? strip.querySelector('.' + CMP_BTN_CLASS) : null);
    CORE.fitCompareButton(strip, find());
    if (_fitTarget === strip) return;
    if (_fitStop) _fitStop();
    _fitTarget = strip;
    _fitStop = CORE.observeCompareFit(strip, find);
  }
  function stopCompareFit() {
    if (_fitStop) _fitStop();
    _fitStop = null;
    _fitTarget = null;
  }
  // ── Compare button (#1452, plan docs/plans/multi-ai-compare.md §3.5) ──
  // 「AI 크로스체크」 / "AI Cross-Check" (formerly 「다른 AI에게도 물어보기」 / "Ask other AIs too", renamed 2026-09-17)
  // next to the gear. Gate = the CDN dark-launch flag (asked ONCE per page
  // load through the service worker: `COMPARE_FLAG` → {on}) AND the `compareEnabled` option
  // (chrome.storage.sync, default on). Click reads the composer's plain text and asks the SW to open
  // compare.html — the SW owns the tab, and any optional-host permission prompt happens on that page
  // under a user gesture (AC16: no `permissions.request` here).
  //
  // 🔴 No usage-shared core call in this block (#1421): plain DOM + chrome.runtime only.
  const CMP_BTN_CLASS = 'ct-cmp-btn';
  let _cmpFlag = null;        // null = not asked yet; true/false = SW answer (cached per page load)
  let _cmpFlagPending = false;
  let _cmpEnabled = true;     // compareEnabled option
  // compareMsgButtonEnabled option (default on): gates ONLY the per-question rows under the
  // bubbles (syncMessageButtons), never the strip button — off leaves the composer button alone.
  let _cmpMsgEnabled = true;

  const cmpAllowed = () => _cmpFlag === true && _cmpEnabled;

  function ensureCompareFlag() {
    if (_cmpFlag !== null || _cmpFlagPending || !_cmpEnabled) return;
    _cmpFlagPending = true;
    try {
      chrome.runtime.sendMessage({ type: 'COMPARE_FLAG' }, (res) => {
        _cmpFlagPending = false;
        // A runtime error (no handler in an older SW) or a non-`on` answer both mean "no button".
        // `cta`, not `on`: the page may be live (flags.json.compare) while the button stays hidden
        // (flags.json.compare_cta — 2026-09-18 launch order: site entry first).
        _cmpFlag = !chrome.runtime.lastError && !!(res && res.cta === true);
        // Re-render on BOTH answers: a previous instance may have left its button in the shared
        // strip, and only a render with the fresh answer removes it (Codex #13).
        if (isCurrent()) renderStrip();
      });
    } catch { _cmpFlagPending = false; _cmpFlag = false; }
  }

  /** Plain text of the composer; '' when empty/absent. */
  function readComposerText() {
    // The new composer has no #prompt-textarea — the editor is the ProseMirror div inside the form.
    const form = findComposerForm();
    const editor = (form && form.querySelector('#prompt-textarea, div.ProseMirror[contenteditable="true"], textarea'))
      || document.querySelector('#prompt-textarea');
    if (!editor) return '';
    if (editor.tagName === 'TEXTAREA') return String(editor.value || '').trim();
    return String(editor.innerText || editor.textContent || '').trim();
  }

  function mountCompareButton(strip) {
    const existing = strip.querySelector('.' + CMP_BTN_CLASS);
    if (!cmpAllowed()) { if (existing) existing.remove(); return; }
    if (existing) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = CMP_BTN_CLASS;
    btn.textContent = t('cmp_ask_others');
    btn.title = t('cmp_ask_others_tip');
    // Always enabled (2026-09-21, user decision): an empty composer opens the compare page with an
    // empty question box instead of greying the button out — the page is a valid entry point on its own.
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const q = readComposerText();
      try { chrome.runtime.sendMessage({ type: 'OPEN_COMPARE', src: PROVIDER, q, placement: 'composer' }); } catch { /* context dead */ }
    });
    (strip.querySelector('.ct-cg-strip-inner') || strip).appendChild(btn);
    ensureCompareFit(strip);
  }

  // Per-question rows (2026-09-21, user request): the same label under every user message
  // bubble, carrying THAT question (placement:'message'), plus a gear that opens the options page
  // at the cross-check card. The row/gear/ownership/relabel logic is the SHARED classic script
  // ui/cmp-msg-rows.js (also used by input-usage.js on claude.ai); this block only says what is
  // chatgpt-specific. Live chatgpt.com trees of one user turn — BOTH are handled (the new UI may
  // be an A/B rollout, so the old shape stays as a fallback):
  //   NEW (verified 2026-09-26; no data-message-author-role / data-message-id / section[data-turn]):
  //     div.group/user-message.flex.flex-col.items-end (P)
  //       div[data-user-message-bubble="true"] (BUBBLE, grey; innerText = the question only)
  //       div.flex.flex-row-reverse.items-center.gap-1 (ACTION ROW) > copy / share / edit buttons
  //     (an ancestor div[data-chatgpt-search-unit-key] carries data-chatgpt-search-message-ids —
  //     not needed: rows are keyed by the bubble NODE in ui/cmp-msg-rows.js, never by an id)
  //   OLD (verified 2026-09-21):
  //     section[data-turn="user"] > div > div (GP)
  //       div (P) > div[data-message-id][data-message-author-role="user"] (MSG) > div > div > div (grey bubble)
  //       div (ACTION ROW, flex justify-end, always laid out) > div (hover-only copy/share/edit buttons)
  // The row is APPENDED to the action row: same line right under the bubble next to the actions,
  // zero extra vertical space. In the NEW row (flex-row-reverse) the last DOM child renders at the
  // LEFT end, i.e. just left of the buttons, which keep their own positions — acceptable by design.
  // Fallback when no action row is found (chatgpt.com re-shaped the turn): right after the bubble,
  // the same degradation claude.ai has.
  //
  // 🔴 SOFT dependency (#1421): ui/cmp-msg-rows.js is listed before this file in CHATGPT_INJECT,
  // but a persisted registration from an older build can run this file without it. Then
  // `__ctCmpMsgRows` is undefined and the rows are silently off — never a throw, and the strip
  // (with its own compare button) is untouched.
  const CMP_MSG_NEW = '[data-user-message-bubble]';
  const CMP_MSG_OLD = '[data-message-author-role="user"]';
  const CMP_MSG_SELECTOR = CMP_MSG_NEW + ', ' + CMP_MSG_OLD;
  // Row class of ui/cmp-msg-rows.js (ROW_CLASS there; the CSS and the guards use it too).
  const CMP_MSG_ROW_CLASS = 'ct-cmp-msg';

  /** Plain text of one user bubble (innerText = the question only in both shapes; attachments and
   *  the action row live outside it — verified 2026-09-21 old / 2026-09-26 new); '' when empty. */
  function readMessageText(bubble) {
    return String(bubble.innerText || bubble.textContent || '').trim();
  }

  /** Which shape `el` is a bubble of ('new' | 'old'), or null. One selector at a time — never a
   *  comma list through matches()/closest() (the guard's mini-dom supports those only per part). */
  function bubbleShape(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.matches(CMP_MSG_NEW)) return 'new';
    if (el.matches(CMP_MSG_OLD)) return 'old';
    return null;
  }

  /** A bubble inside another bubble (an A/B page carrying both markers on one turn) is not a
   *  bubble of its own: only the outermost one gets a row, so one turn never gets two. */
  function isNestedBubble(bubble) {
    for (let n = bubble.parentElement; n; n = n.parentElement) if (bubbleShape(n)) return true;
    return false;
  }

  /** The next element sibling that is not one of our rows (a fallback row sits right after the
   *  bubble and carries buttons — it must never be taken for the site's action row). */
  function nextSiteSibling(el) {
    let n = el && el.nextElementSibling;
    while (n && n.classList && n.classList.contains(CMP_MSG_ROW_CLASS)) n = n.nextElementSibling;
    return n;
  }

  /** The site's action row: a laid-out element with buttons that is not itself a bubble. */
  function isActionRow(el) {
    return !!el && !bubbleShape(el) && !!el.querySelector('button');
  }

  /** Where the row goes: the turn's action row (identified by its buttons) as its last child,
   *  else right after the bubble. New shape: action row = the bubble's next sibling; old shape:
   *  the next sibling of the bubble's parent. */
  function anchorOfBubble(bubble) {
    const shape = bubbleShape(bubble);
    if (!shape || isNestedBubble(bubble)) return null;
    const p = bubble.parentElement;
    const act = shape === 'new' ? nextSiteSibling(bubble) : (p && p.nextElementSibling);
    if (isActionRow(act)) return { parent: act, before: null };
    return p ? { parent: p, before: bubble.nextSibling } : null;
  }

  /** The bubble a row belongs to, from the row's current position: the row's previous sibling in
   *  the fallback placement, else the bubble just before (new shape) / inside the element before
   *  (old shape) the row's action row. A candidate only counts if anchorOfBubble would put its
   *  row exactly where this row is — the two functions cannot disagree, so no cross-matching
   *  between shapes and no row kept in a place its bubble no longer points to (it is rebuilt). */
  function bubbleOfRow(row) {
    const parent = row.parentElement;
    if (!parent) return null;
    const owns = (b) => { const at = b && anchorOfBubble(b); return !!at && at.parent === parent; };
    const prev = row.previousElementSibling;
    if (bubbleShape(prev) && owns(prev)) return prev;
    const before = parent.previousElementSibling;
    if (bubbleShape(before) === 'new' && owns(before)) return before;
    const inner = before && before.querySelector(CMP_MSG_OLD);
    return owns(inner) ? inner : null;
  }

  const _msgRows = globalThis.__ctCmpMsgRows ? globalThis.__ctCmpMsgRows.create({
    document, chrome, provider: PROVIDER,
    bubbleSelector: CMP_MSG_SELECTOR,
    anchorOf: anchorOfBubble,
    rowOwnerOf: bubbleOfRow,
    readText: readMessageText,
    t,
    gen: () => _gen,
    isCurrent: () => _gen === globalThis.__ctCgInputGen,
    // compareMsgButtonEnabled gates ONLY these rows (the strip button stays on cmpAllowed alone).
    allowed: () => cmpAllowed() && _cmpMsgEnabled,
    gearIconPath: GEAR_ICON_PATH,
  }) : null;

  // Driven by the page-wide MutationObserver tick (new messages arrive as DOM mutations, coalesced
  // into one rAF) and by renderStrip (flag / option / language changes), never by a timer of its own.
  function syncMessageButtons() {
    if (_msgRows) _msgRows.sync();
  }

  // Both branches below replace the strip's markup, so the compare button is (re)attached here,
  // after the markup, rather than inside each branch.
  function renderStripInto(strip) {
    renderStripMarkup(strip);
    mountCompareButton(strip);
  }

  function renderStripMarkup(strip) {
    // Prefer the 5h window; fall back to the 7d window for plans that expose
    // only a weekly limit (e.g. ChatGPT Pro 5x 'prolite', where h5 is null).
    const use7d = _data && _data.h5 == null && _data.d7 != null;
    if (!_data || (_data.h5 == null && _data.d7 == null)) {
      // 🔴 "수집 중" is a claim. When the background knows collection is FAILING it says so
      // (`err`, bg/sidebar-usage.js noDataReason) and this line must not contradict it (#1592).
      // `CORE.noDataReason` may be absent in a tab whose usage-shared.js predates this script
      // (dynamic re-injection, #1421) — then the old line is the honest fallback.
      const text = _data && _data.err ? (CORE.noDataReason ? CORE.noDataReason(_data.err, _lang, 'ChatGPT') : t('no_data')) : t('no_data');
      // Same `.ct-cg-strip-inner` as the data branch: mountCompareButton appends into it, and the
      // seg + button spacing rule in chatgpt-usage.css keys off that adjacency. Bare in the strip,
      // the button sat flush against the sentence.
      strip.innerHTML = `<div class="ct-cg-strip-inner"><span class="ct-cg-strip-seg ct-cg-strip-muted">${CORE.escapeHtml(text)}</span></div>`;
      return;
    }
    // 🔴 Labelled by the span the PROVIDER reported, not by the slot. ChatGPT Free and Go report a
    // 30-day window that lands in the 7d slot, so a static t('weekly') printed "주간 사용률" right
    // next to a 29-day countdown — one line contradicting itself (inquiry #198, confirmed against a
    // live Free account: limit_window_seconds = 2592000). CORE falls back to the static label when
    // there is no span, so Plus/Team/Pro and Claude render exactly as before.
    const win = use7d
      ? { label: CORE.windowLabel(_data.w7s, _lang, t('weekly')), util: _data.d7, reset: _data.r7, pred: _data.pred7d }
      : { label: CORE.windowLabel(_data.w5s, _lang, t('session')), util: _data.h5, reset: _data.r5, pred: _data.pred5h };
    const logoUrl = chrome.runtime.getURL('icons/icon16.png');
    const dot = '<span class="ct-cg-strip-dot">·</span>';
    let main = `<img src="${logoUrl}" class="ct-cg-strip-logo" alt="CT">`;
    // current usage % + gauge bar (with prediction marker).
    main += metric(win.label, win.util, win.pred);
    // ⏱ N 뒤 리셋
    if (win.reset) {
      main += `${dot}<span class="ct-cg-strip-seg ct-cg-strip-reset" data-reset="${win.reset}" title="${CORE.escapeHtml(CORE.formatResetAbsolute(win.reset, _lang))}">${CORE.escapeHtml(resetLabel(win.reset))}</span>`;
    }
    // 리셋 시 예상 N% — predicted util at reset, percent colored by status.
    if (win.pred != null) {
      const predColor = CORE.gaugeColor(win.pred);
      const predText = win.pred >= 100 ? '100%+' : `${Math.round(win.pred)}%`;
      main += `${dot}<span class="ct-cg-strip-seg"><span class="ct-cg-strip-muted">${CORE.escapeHtml(t('est_reset'))}</span> <span style="color:${predColor}">${predText}</span></span>`;
    }
    if (_data.plan) {
      main += `${dot}<span class="ct-cg-strip-seg ct-cg-strip-muted">${CORE.escapeHtml(CORE.planDisplayName(_data.plan, 'chatgpt'))}</span>`;
    }
    strip.innerHTML =
      `<div class="ct-cg-strip-inner">` +
        `<a class="ct-cg-strip-main" href="${SITE_URL}/dashboard/?utm_source=chatgpt_input" target="_blank" rel="noopener">${main}</a>` +
        `<button class="ct-cg-strip-gear" title="${CORE.escapeHtml(t('settings'))}" aria-label="${CORE.escapeHtml(t('settings'))}">${GEAR_SVG}</button>` +
        `<a class="ct-cg-strip-gear ct-cg-strip-contact" href="${contactUrl()}" target="_blank" rel="noopener" title="${CORE.escapeHtml(t('contact'))}" aria-label="${CORE.escapeHtml(t('contact'))}">${CONTACT_SVG}</a>` +
      `</div>`;
    const gear = strip.querySelector('.ct-cg-strip-gear');
    if (gear) gear.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try { chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS', hash: 'page-usage' }); } catch { /* context dead */ }
    });
  }

  function renderStrip() {
    const strip = document.getElementById(STRIP_ID);
    if (strip) renderStripInto(strip);
    syncMessageButtons();
  }

  function updateCountdowns() {
    document.querySelectorAll(`#${STRIP_ID} .ct-cg-strip-reset[data-reset]`).forEach(el => {
      const r = el.dataset.reset;
      if (r) el.textContent = resetLabel(r);
    });
  }

  // ── Mount / unmount ──
  function mount() {
    if (document.getElementById(STRIP_ID)) { _mounted = true; return; }
    const anchor = findAnchor();
    if (!anchor) { _mounted = false; return; }
    const strip = buildStrip();
    if (anchor.type === 'belowbox' || anchor.type === 'belowcontainer') {
      strip.classList.add('ct-cg-strip-belowbox'); // full-width row under the box
      anchor.el.parentNode.insertBefore(strip, anchor.el.nextSibling);
    } else {
      anchor.el.parentNode.insertBefore(strip, anchor.el);
    }
    // Remembered so the tick can notice the page changed shape underneath us — see ensureMounted().
    // The TYPE alone is not enough: a composer subtree can be replaced by another of the same
    // shape, and then the type matches while the element does not.
    strip.dataset.ctAnchor = anchor.type;
    _anchorEl = anchor.el;
    _mounted = true;
  }

  let _anchorEl = null;

  function unmount() {
    const el = document.getElementById(STRIP_ID);
    if (el) el.remove();
    _anchorEl = null;
    _mounted = false;
    stopCompareFit();
  }

  function ensureMounted() {
    if (!_enabled) { unmount(); return; }
    if (!isCurrent()) return;
    const el = document.getElementById(STRIP_ID);
    if (!el) { _mounted = false; mount(); return; }

    // 🔴 MOUNTED IS NOT THE SAME AS MOUNTED IN THE RIGHT PLACE. Chat ↔ Work is a client-side
    // toggle: the composer box gains or loses its row with no navigation and without ever removing
    // our strip. Every pre-existing remount trigger keys on the node being GONE, so a strip mounted
    // in Chat mode stayed exactly where it was — wrong — for the whole Work session.
    const want = findAnchor();

    // 🔴 NO ANCHOR MEANS NO STRIP. Placing the strip outside the composer box severed the lifetime
    // it used to inherit: when the strip lived INSIDE that subtree, removing the composer removed
    // the strip too, and the existing "is the node gone" recovery took over. Outside, an orphan
    // strip — with a live compare button — can outlive the composer on a composerless view for as
    // long as the tab stays open (Codex, #1491 finding 1).
    if (!want) { unmount(); return; }

    const placedRight = want.type === 'disclaimer'
      ? el.nextElementSibling === want.el
      : el.previousElementSibling === want.el;

    if (want.type !== el.dataset.ctAnchor || want.el !== _anchorEl || !placedRight) {
      unmount();
      mount();
    }
  }

  // Fully stop this instance (superseded by a newer injection, or ChatGPT
  // host permission revoked): remove DOM, clear timers, disconnect observers,
  // and unregister runtime/storage listeners (else reinjection accumulates them).
  function teardown() {
    _enabled = false;
    unmount();
    // Superseded: the newer instance rebuilds the rows itself (gen ownership). Revoked (still the
    // newest instance): nobody else will, so the rows with our handlers go too.
    if (_msgRows && _gen === globalThis.__ctCgInputGen) _msgRows.removeAll();
    _intervals.forEach(clearInterval);
    _intervals = [];
    if (_observer) { _observer.disconnect(); _observer = null; }
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch { /* context dead */ }
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch { /* context dead */ }
  }

  // ── Data ──
  let _reqSeq = 0;
  function requestUsageData() {
    if (!isCurrent()) return;
    const seq = ++_reqSeq;
    try {
      chrome.runtime.sendMessage({ type: 'GET_SIDEBAR_USAGE', provider: PROVIDER, orgId: null }, (res) => {
        if (!isCurrent()) return; // a newer instance superseded this one mid-flight
        if (seq !== _reqSeq) return;
        if (chrome.runtime.lastError) return;
        if (res && res.revoked) { teardown(); return; } // ChatGPT permission gone
        if (!res) { // explicit empty (no ChatGPT data) — clear stale display
          if (_data !== null) { _data = null; renderStrip(); }
          return;
        }
        // 🔴 THE SPANS ARE PART OF THE COMPARISON, because they decide the label now. Leaving them
        // out would let a span-only change (a plan move that turns a 7-day window into a 30-day one
        // at the same percentage) be filtered as "no change", and the widget would keep showing the
        // old — now false — label until some other field happened to differ.
        if (_data && _data.h5 === res.h5 && _data.d7 === res.d7 && _data.r5 === res.r5 &&
            _data.r7 === res.r7 && _data.pred5h === res.pred5h && _data.pred7d === res.pred7d &&
            _data.w5s === res.w5s && _data.w7s === res.w7s &&
            _data.plan === res.plan && _data.err === res.err) return;
        _data = res;
        // _lang follows the user's extension language setting, not res.lang
        // (a Claude-snapshot field that defaults to 'en' for ChatGPT).
        renderStrip();
      });
    } catch { /* context dead */ }
  }

  function onRuntimeMessage(message) {
    if (!isCurrent()) return;
    if (message.type === 'SIDEBAR_USAGE_REFRESH') requestUsageData();
  }

  function onStorageChanged(changes, area) {
    if (!isCurrent()) return;
    if (area === 'local') {
      if (changes.accountCache || changes.independentAccount) loadAccount();
      return;
    }
    if (area !== 'sync') return;
    if (changes.compareEnabled) {
      _cmpEnabled = changes.compareEnabled.newValue !== false;
      ensureCompareFlag();
      renderStrip();
    }
    if (changes.compareMsgButtonEnabled) {
      // Only the per-question rows follow this one; the strip is untouched (syncMessageButtons
      // removes or rebuilds the rows on its own).
      _cmpMsgEnabled = changes.compareMsgButtonEnabled.newValue !== false;
      syncMessageButtons();
    }
    if (changes.chatgptInputUsageEnabled) {
      _enabled = changes.chatgptInputUsageEnabled.newValue !== false;
      if (!_enabled) unmount(); else { requestUsageData(); ensureCompareFlag(); }
    }
    if (changes.lang) {
      _lang = changes.lang.newValue === 'auto' ? CORE.detectLang() : changes.lang.newValue;
      renderStrip();
    }
  }

  // ── Loop + observer ──
  let _lastMountCheck = 0;
  function tick() {
    if (!isCurrent()) { teardown(); return; } // superseded → stop the RAF loop
    try {
      const now = Date.now();
      if (now - _lastMountCheck >= MOUNT_INTERVAL_MS) {
        _lastMountCheck = now;
        ensureMounted();
      }
    } catch { /* never kill the loop */ }
    requestAnimationFrame(tick);
  }

  let _observer = null;
  // chatgpt.com mutates on every streamed token; the rows only need one pass per burst, so the
  // sync is coalesced into a single rAF tick (input-usage.js does the same).
  let _rowsSyncScheduled = false;
  function scheduleRowsSync() {
    if (_rowsSyncScheduled) return;
    _rowsSyncScheduled = true;
    requestAnimationFrame(() => { _rowsSyncScheduled = false; if (isCurrent()) syncMessageButtons(); });
  }
  function startObserver() {
    if (_observer) return;
    _observer = new MutationObserver(() => {
      if (!isCurrent()) { teardown(); return; }
      scheduleRowsSync(); // the rows do not depend on the strip option
      if (!_enabled) return;
      if (!document.getElementById(STRIP_ID)) { _mounted = false; mount(); }
    });
    _observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── Init ──
  function init() {
    chrome.storage.sync.get({ lang: 'auto', chatgptInputUsageEnabled: true, compareEnabled: true, compareMsgButtonEnabled: true }, (cfg) => {
      _lang = cfg.lang === 'auto' ? CORE.detectLang() : cfg.lang;
      _enabled = cfg.chatgptInputUsageEnabled !== false;
      _cmpEnabled = cfg.compareEnabled !== false;
      _cmpMsgEnabled = cfg.compareMsgButtonEnabled !== false;
      if (_enabled) requestUsageData();
      // The flag is asked regardless of the usage strip: the per-question rows do not live in the
      // strip, so a user who switched it off still gets them when the cross-check options are on
      // (same fix as input-usage.js, 1.32.1 batch review).
      ensureCompareFlag();
    });
    loadAccount(); // prefill name/email into the inquiry link

    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    chrome.storage.onChanged.addListener(onStorageChanged);

    requestAnimationFrame(tick);
    startObserver();
    _intervals.push(setInterval(updateCountdowns, COUNTDOWN_INTERVAL_MS));
    _intervals.push(setInterval(requestUsageData, REFRESH_INTERVAL_MS));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
