// ui/compare/port.js — the PORT / STREAMING slice of mountComparePage() (compare.js): the one
// port per session to the service worker (ensurePort / closePort / settlePortLoss), every message
// it carries (onPortMessage: CONSUME_OK|FAIL, CHUNK, MODEL(S), DONE, ERROR, ACTIVITY, DIAG,
// ALL_DONE), the CONSUME_FAIL notices, the MV3 keepalive with its idle cap, and the send path
// (beginSend / finishSend / currentTargets). The port-local `let`s (listener, keepalive timer,
// the port-loss diagnostic bookkeeping) live here; the status epoch / read sequence stay in
// compare.js behind ctx.bumpStatusEpoch() / ctx.currentStatusReadSeq(). Bodies are exactly as
// they were in compare.js (test/mutants/compare-page.json anchors on them). The ctx contract is
// written up in history.js.

import { COMPARE_PORT_NAME, SESSION_ID_RE, NOTICE_OWNER_LOGIN, NOTICE_OWNER_QUOTA, HTTP_UNAUTHORIZED, HTTP_FORBIDDEN, HTTP_NOT_FOUND, HTTP_TOO_MANY, CODE_COMPARE_QUOTA, CODE_NO_TARGETS, CODE_BUSY, CODE_NETWORK_ERROR, CODE_ABORTED, CODE_SESSION_ENDED, CUT_STREAM_ERROR, PORT_MSG_PING, KEEPALIVE_MS, KEEPALIVE_MAX_IDLE_MS, CODE_SEND_FAILED, SEND_KIND_SUMMARY, SEND_KIND_RETRY, SEND_VIA_COLUMN, GATE_CODES, PROVIDER_BUSY_CODES, STAGE_SEND_START, TTFT_STAGES, STAGE_TOOL_USE, BADGE_SEARCHING, BADGE_WAITING, BADGE_UPLOADING, STAGE_ATTACHMENT_UPLOADED, MS_PER_SECOND } from './constants.js';
import { autoGrow, sendableTargets } from './helpers.js';
import { attachmentsForRound, roundOwnsTray } from './attachments.js';
import { linkErrorText } from './link.js';

/** Installs the port / streaming slice onto `ctx` (see ui/compare/history.js for the ctx contract). */
export function installPort(ctx) {
  const { chrome, doc, state, t, clock, con, src, track } = ctx;
  /** The column an SW event is about: `col` (colId — the contract) or, from an SW that names only the provider, that provider's first column. */
  const columnForMsg = (msg) => state.columns.get(typeof msg.col === 'string' ? msg.col : msg.provider);
  // ── port / streaming ──
  function onPortMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      // The pasted conversation was read (#1651). A RECEIPT, never the words: the worker keeps the
      // transcript for the round it composes, and what arrives here is what the chip is made of.
      case 'LINK_OK': {
        if (!state.linkReading) return;                 // cancelled while it was being read
        state.linkReading = false;
        state.link = {
          provider: msg.provider,
          title: typeof msg.title === 'string' ? msg.title : null,
          turns: Number.isFinite(msg.turns) ? msg.turns : 0,
          truncated: msg.truncated === true,
        };
        ctx.renderAttachment();
        ctx.updateControls();
        return;
      }
      case 'LINK_FAIL': {
        if (!state.linkReading) return;
        // 🔴 Through clearLink(), so the 「시크릿 대화」 toggle this link turned off goes back with
        // it (Codex 3/3 1R blocker 1) — a read that failed changed nothing, and must leave nothing
        // changed. The reason survives the clear, because it is the one thing the user needs.
        const why = linkErrorText(msg.code, msg.provider);
        ctx.clearLink();
        state.linkError = why;
        ctx.renderAttachment();
        ctx.updateControls();
        return;
      }
      case 'CONSUME_OK': {
        const first = !state.sessionStarted;
        if (first) { ctx.commitPrompt(state.question); ctx.renderQuestionBubbles(); if (!state.sessionId) state.sessionId = ctx.newSessionId(); state.firstRound = state.roundInFlight; }
        state.sessionStarted = true;
        state.rounds++;
        // A summary (or its retry) is ABOUT a comparison, not a new one: it leaves the active round
        // where it is — the next summary still speaks of the round the user is working on (5R gap a).
        if (Number.isFinite(state.roundInFlight) && !state.summaryPending) state.activeRound = state.roundInFlight;
        // A SEND{resume} was accepted (D3): the new port carries the session again — the lost
        // one is history, the keepalive below runs for this one.
        if (state.resuming) { state.resuming = false; state.resumed = true; state.sessionEnded = false; state.idleEnded = false; }
        state.pendingFollowup = '';
        // The link went out with this round, so nothing of it is left (#1634's rule: when a round
        // ends, nothing of that round survives it). A REFUSED round keeps it, exactly like the
        // text draft beside it.
        if (state.link || state.linkOffer || state.linkError) ctx.clearLink();
        // This round was the DOCK COMPOSER's, so the tray it was composed with is finished: its
        // files went out and its refusal line has nothing left to explain (#1634 3R). A summary, a
        // retry or a column follow-up owns no tray and ends nothing. A REFUSED round keeps
        // everything, exactly like the text draft beside it.
        // Read BEFORE consumeAttachment() empties the tray — the badges below need to know how
        // many files this round is carrying, and the chips are dropped in the same pass.
        const uploadCount = state.roundOwnsTray ? state.attachItems.filter((a) => !a.reading).length : 0;
        if (state.roundOwnsTray) ctx.consumeAttachment();
        state.summaryPending = null; // the compare was spent: the summary round is under way (C5)
        for (const col of state.columns.values()) {
          // The round is accepted: the last pre-round turn is history now — its countdown retires (3R #7).
          if (col.round && col.turns.length > col.round.turns) ctx.retireCountdown(col.turns[col.round.turns - 1]);
          col.round = null;
          // 🔴 THE ROUND COMMITTED, so a readiness failure in it is no longer a floating diagnosis:
          // it is on a TURN that stays, like any other column error. Only an attempt that was
          // ROLLED BACK needs the column-level copy (#1463 ②) — keeping it past a commit made the
          // next send wipe a committed error's badge and tooltip along with it.
          col.readiness = null;
          // A round carrying files starts in the UPLOADING state on every column that is actually
          // uploading them (#1617 진행 표시): with images attached the columns diverge by seconds,
          // and nine silent seconds read as a hang. Each `attachment_uploaded` below counts one
          // file down; the LAST one moves that column on to the ordinary wait.
          if (col.status === 'streaming' && !col.turns[col.turns.length - 1].text) {
            const uploading = uploadCount > 0 && ctx.providerTakesFiles(col.provider);
            col.uploadsTotal = uploading ? uploadCount : 0;
            col.uploadsDone = 0;
            col.uploadsSeen = null;   // a fresh round counts its own files
            ctx.setBadge(col, uploading ? BADGE_UPLOADING : BADGE_WAITING, 'is-streaming');
          }
        }
        if (state.roundGen === state.quotaGen) {
          // `pro` is not on CONSUME_OK — keep the status answer's value (limit:null alone is not Pro).
          //
          // 🔴 UNLESS THE SERVER JUST COUNTED THIS SEND (#1463 ③). Finite `remaining`/`limit` mean
          // the server is metering this account, which contradicts a `pro` read minutes ago — a
          // subscription that lapsed while the page stayed open. The cached flag used to win, so
          // the line said 「Pro · 무제한」 while the server was refusing at 3. The fresh answer is
          // the one that was just measured; `refreshQuota()` then confirms it out of band (and
          // puts `pro` back if the count was the anomaly).
          const counted = msg.remaining != null && msg.limit != null
            && Number.isFinite(Number(msg.remaining)) && Number.isFinite(Number(msg.limit));
          const cachedPro = !!(state.status.quota && state.status.quota.pro);
          // An UNCOUNTED page (limit:null — gates dark, or no status answer at all) that just got
          // counted learned the numbers from this message but nothing else about the policy: the
          // server that now counts may also have retired the beta reset (1.32.0 batch review #2 —
          // the page reached 0/30 with a stale `betaReset:true` and offered a reset that 404s
          // instead of the Premium CTA). Same out-of-band confirmation as the cached-pro case.
          const cachedUncounted = !state.status.quota || state.status.quota.limit == null;
          state.status.quota = { ...(state.status.quota || {}), remaining: msg.remaining, limit: msg.limit, resetsAt: msg.resetsAt, pro: counted ? false : cachedPro };
          ctx.bumpStatusEpoch(); // this count is newer than any status answer still in flight
          ctx.renderQuota(state.status.quota, null);
          if (counted && (cachedPro || cachedUncounted)) ctx.refreshQuota();
        } else {
          // The round went out before a beta reset (§5 reverse race): its count is a pre-reset
          // snapshot (a debit to 0 that the reset has since cleared) — the round settles, the
          // count comes from a fresh read.
          ctx.refreshQuota();
        }
        ctx.stopBtn.disabled = false;
        startKeepalive(); // the session exists in the SW from here on — keep the SW alive for it
        // The round is accepted: the follow-up composers appear NOW (the next question can be
        // drafted while the answers stream; their send buttons stay off until ALL_DONE), and the
        // question card drops its send button. Waiting for ALL_DONE here left the composer hidden
        // behind the slowest column (finding A).
        ctx.updateControls();
        // The caret moves to the follow-up composer (the dock's new face) — but only when it is
        // still where the send left it (the question textarea / send button / nowhere). If the
        // user went elsewhere during a slow prepare, leave them there; and never scroll to do it
        // (Codex 1R #2).
        if (first) {
          const active = doc.activeElement || null;
          if (!active || active === doc.body || active === ctx.qInput || active === ctx.sendBtn) ctx.focusQuietly(ctx.followup.input);
        }
        return;
      }
      case 'CONSUME_FAIL': {
        // No provider send happened (AC18) — roll every column back to where this round started.
        // The round never happened, so a late ALL_DONE must not read it as "every target failed"
        // (Codex 2R #1).
        state.roundTargets = [];
        state.summaryPending = null; // nothing was spent: the folded request below is popped with the round (C5)
        for (const col of state.columns.values()) {
          const r = col.round;
          if (!r) continue;
          while (col.turns.length > r.turns) col.turns.pop().root.remove();
          col.round = null;
          col.status = r.status;
          col.errorCode = r.errorCode;
          // The badge re-reads it in setBadge below; the error LINE kept its own copy on the turn
          // that survived the pop (Codex ext 1R #1: a rolled-back retry lost the badge tooltip).
          col.errorTitle = r.errorTitle;
          col.participated = col.turns.length > 0;
          col.servedModel = r.servedModel;
          col.stages = r.stages;
          // #1463 ②: the turn is gone (nothing was sent), the REASON is not. A column that failed
          // readiness stays visibly errored with its code, so renderColumnActions keeps the C3 row
          // — the login link / permission button / 「탭 열기」 that make the next send work.
          if (col.readiness) {
            col.status = 'error';
            col.errorCode = col.readiness.code;
            col.errorTitle = col.readiness.title;
            ctx.setBadge(col, 'col_error', 'is-error');
          } else {
            ctx.setBadge(col, r.badgeKey, r.badgeCls);
          }
          ctx.renderColumnActions(col);
        }
        // The draft goes back where it was typed — the column's own composer (re-opened) when the
        // send came from there, else the dock — unless the user already typed something new there.
        if (state.pendingFollowup) {
          const colBack = state.pendingFollowupCol ? state.columns.get(state.pendingFollowupCol) : null;
          // Re-opened outright: the port may be gone at this instant (finishSend → updateControls folds it again if the column is dead by then).
          if (colBack) { if (!colBack.askInput.value) colBack.askInput.value = state.pendingFollowup; ctx.setColumnAsk(colBack, true); }
          else for (const c of ctx.composers) { if (!c.input.value) { c.input.value = state.pendingFollowup; autoGrow(c.input); } }
        }
        state.pendingFollowup = '';
        state.pendingFollowupCol = null;
        // A first-round failure never touched the question card: the textarea still holds the
        // text and finishSend() → updateControls() unlocks it (readOnly follows `sending`).
        renderConsumeFail(msg);
        track('consume_fail', { status: Number(msg.status) || 0, code: typeof msg.code === 'string' ? msg.code : '' });
        // Nothing was sent, so the SW session holds no conversation worth keeping. Drop the port:
        // a retry then opens a fresh one and SEND is again the first message (contract), instead
        // of a second SEND on a port that already saw one (Codex #4). A failed SEND{resume} drops
        // its fresh port for the same reason — the session stays lost-but-resumable (D3), and the
        // next attempt is again a first-message SEND{resume}.
        if (!state.sessionStarted) closePort();
        if (state.resuming) { state.resuming = false; closePort(); }
        finishSend();
        return;
      }
      case 'CHUNK': {
        const col = columnForMsg(msg);
        if (!col || col.status !== 'streaming') return;
        const turn = col.turns[col.turns.length - 1];
        const hadText = !!turn.text;
        turn.text += String(msg.delta || '');
        ctx.setBadge(col, 'col_streaming', 'is-streaming');
        ctx.scheduleRender(col);
        if (!hadText && turn.text) { ctx.syncCopyAll(); ctx.foldActivity(turn); } // the first text on the page enables 「전체 복사」; the process folds under the answer
        return;
      }
      case 'MODEL': {
        // Served model, as soon as the client knows it (addendum). Only for the column's live round.
        const col = columnForMsg(msg);
        if (!col || col.status !== 'streaming') return;
        ctx.setServedModel(col, msg.model);
        return;
      }
      case 'MODELS': {
        ctx.applyModels(msg);
        return;
      }
      case 'DONE': {
        const col = columnForMsg(msg);
        if (!col || col.status !== 'streaming') return;
        const turn = col.turns[col.turns.length - 1];
        if (typeof msg.text === 'string' && msg.text) turn.text = msg.text;
        // #1519 / #1527: answered as far as it got — still a DONE. `cutReason` (SW vocabulary,
        // two values) only picks which sentence goes under it; everything else is one path.
        if (msg.stalled === true) {
          turn.stalled = true;
          if (msg.cutReason === CUT_STREAM_ERROR) turn.cutError = true;
        }
        col.status = 'done';
        turn.node.classList.remove('is-streaming');
        ctx.foldActivity(turn, true);
        ctx.paintAssistant(col);
        ctx.settleTurn(turn);
        ctx.renderColumnActions(col);
        if (msg.model) ctx.setServedModel(col, msg.model);
        ctx.setBadge(col, 'col_done', 'is-done');
        // The continuation (D3) is remembered ONLY for a kept session: an incognito session's
        // conversations are deleted / hidden at dispose, so there is nothing to resume — and the
        // guard pins that such a session never sends `resume`, whatever DONE carried.
        if (state.sessionSaveHistory === true && msg.continuation && typeof msg.continuation === 'object') col.continuation = msg.continuation;
        {
          const ttft = ctx.ttftSeconds(col);
          track('column_done', { provider: col.provider, col: ctx.gaCol(col), ttft_ms: ttft ? Math.round(Number(ttft.first) * MS_PER_SECOND) : -1, total_ms: ttft && ttft.total != null ? Math.round(Number(ttft.total) * MS_PER_SECOND) : -1, chars: turn.text.length, model: ctx.servedModelId(col) });
        }
        return;
      }
      case 'ERROR': {
        const col = columnForMsg(msg);
        if (!col || col.status !== 'streaming') return;
        const turn = col.turns[col.turns.length - 1];
        col.status = 'error';
        col.errorCode = msg.code || 'unknown';
        col.errorTitle = ctx.errorTitle(msg);
        turn.node.classList.remove('is-streaming');
        turn.node.classList.add('is-error');
        // Keep whatever streamed before the failure, then the reason underneath it (and the raw
        // cause in its title).
        turn.errorText = ctx.errorText(col.provider, col.errorCode, typeof msg.reason === 'string' ? msg.reason : '', msg.budgetMs);
        // C3: a provider-side limit with the 5h gauge full — the line also says when it resets.
        // The INSTANT is stored (never the relative string: it would freeze, and it would be
        // persisted into history); errorLineText() renders the countdown, the ticker keeps it current.
        turn.resetAt = PROVIDER_BUSY_CODES.has(col.errorCode) ? ctx.usageResetAt(col) : null;
        // C3: a gate code needs a status read STARTED after this error to bring the retry back
        // (statusReadSeq — Codex batch-1 #2: a read in flight from before the error is stale).
        if (GATE_CODES.has(col.errorCode)) { col.gateCleared = false; col.gateErrorSeq = ctx.currentStatusReadSeq(); }
        turn.errorTitle = col.errorTitle;
        ctx.settleActivity(turn); // an open 「검색 중…」 must not pulse under an error line
        ctx.paintAssistant(col);
        ctx.settleTurn(turn);
        ctx.setBadge(col, col.errorCode === CODE_ABORTED ? 'col_aborted' : 'col_error', col.errorCode === CODE_ABORTED ? 'is-muted' : 'is-error');
        ctx.renderColumnActions(col);
        // The action row appended after the paint must end up in view too — for a short answer the
        // reader is still following; an anchored / scrolled-up column keeps its place (the pill shows it).
        if (!col.followAnchored && !col.userScrolledUp) ctx.scrollColumnToEnd(col); else ctx.syncJumpButton(col);
        // `readiness`: the SW's prepare() step failed (its message reads `not ready: <code>`), as
        // opposed to a failure while the answer was being produced (contract: ERROR.message).
        const isReadiness = /^not ready/.test(String(msg.message || ''));
        // 🔴 #1463 ②: a readiness failure is the one error whose TURN is about to be thrown away.
        // When every column fails it the SW sends ERROR×N and then CONSUME_FAIL{no_targets}, and
        // the rollback pops the turns that carry these lines — so the user was left with a generic
        // 「보낼 수 없었어요」 and no idea which account needed what. Kept at COLUMN level, where the
        // rollback cannot reach it, and rendered next to the C3 buttons that answer it.
        if (isReadiness) col.readiness = { code: col.errorCode, title: col.errorTitle, text: turn.errorText };
        track('column_error', { provider: col.provider, col: ctx.gaCol(col), code: col.errorCode, reason: typeof msg.reason === 'string' ? msg.reason : '', readiness: isReadiness });
        return;
      }
      case 'ACTIVITY': {
        const col = columnForMsg(msg);
        if (!col || col.status !== 'streaming') return;
        const turn = col.turns[col.turns.length - 1];
        if (!turn || turn.role !== 'assistant' || !turn.activity) return;
        ctx.applyActivity(turn.activity, msg);
        return;
      }
      case 'DIAG': {
        const col = columnForMsg(msg);
        if (!col) return;
        // 🔍 The client started a tool (package v0.3.1: Claude's web search) before any text: say
        // so instead of 「응답 대기 중…」. Only a streaming column with no text yet; the first CHUNK's
        // 「답변 중…」 replaces it. Not a waiting state, so the ticker adds no seconds to it (the
        // search has its own pace; a stale count would read as the search's).
        // One of this column's files is up (package `attachment_uploaded`). Count it; the LAST one
        // hands the column over to the ordinary wait — bytes stopped moving, the model starts.
        // Only from the uploading state: a late diag must not reset a column that has since begun
        // streaming text, and the wait that follows runs its own fresh clock.
        if (msg.stage === STAGE_ATTACHMENT_UPLOADED) {
          if (col.badgeKey !== BADGE_UPLOADING || col.status !== 'streaming') return;
          // 🔴 COUNT FILES, NOT EVENTS (1R follow-up 1). The diag names which file it is, so a
          // repeat of one is not progress: five copies of `index: 0` used to finish a five-file
          // round. Defensive — no path in the package or the SW is known to repeat one — but the
          // whole point of this badge is to say how far along the upload is, and a counter that
          // trusts arrivals rather than identities cannot.
          const idx = msg.detail && Number.isInteger(msg.detail.index) ? msg.detail.index : null;
          if (idx !== null) {
            if (!col.uploadsSeen) col.uploadsSeen = new Set();
            if (col.uploadsSeen.has(idx)) return;
            col.uploadsSeen.add(idx);
          }
          col.uploadsDone = (col.uploadsDone || 0) + 1;
          if (col.uploadsDone >= (col.uploadsTotal || 1)) ctx.setBadge(col, BADGE_WAITING, 'is-streaming');
          else ctx.paintBadge(col);   // 「이미지 2/5 올리는 중」 — the same state, one file further on
          return;
        }
        if (msg.stage === STAGE_TOOL_USE) {
          const turn = col.turns[col.turns.length - 1];
          if (col.status === 'streaming' && turn && turn.role === 'assistant' && !turn.text) ctx.setBadge(col, BADGE_SEARCHING, 'is-streaming');
          return;
        }
        // Readiness stages from the SW (package v0.2.3) are logged there; the page keeps only the
        // TIMED send-path stages of the column's live round (package v0.3.0) for the badge.
        if (!TTFT_STAGES.has(msg.stage) || (col.status !== 'streaming' && col.status !== 'done')) return;
        const at = msg.detail && msg.detail.at;
        if (typeof at !== 'number' || !Number.isFinite(at)) return;
        // Round isolation on one port (Codex b2 1R #4): a previous round's stage delivered late
        // is OLDER than this round's send_start — anything before the recorded send_start is
        // dropped, and a stage never moves backwards (a client retry re-reports later times; the
        // LAST attempt is the one that answered, like the SW's own ttft line).
        const start = col.stages[STAGE_SEND_START];
        if (Number.isFinite(start) && at < start) return;
        if (Number.isFinite(col.stages[msg.stage]) && at < col.stages[msg.stage]) return;
        col.stages[msg.stage] = at;
        if (col.status === 'done') ctx.paintBadge(col); // stream_done landing after DONE completes the tooltip
        return;
      }
      case 'ALL_DONE': {
        for (const col of state.columns.values()) {
          if (col.status === 'streaming') { col.status = 'done'; ctx.setBadge(col, 'col_done', 'is-done'); ctx.foldActivity(col.turns[col.turns.length - 1], true); ctx.paintAssistant(col); ctx.settleTurn(col.turns[col.turns.length - 1]); ctx.renderColumnActions(col); }
        }
        // No answer anywhere (not by the user's Stop) → say so once, above the columns: every
        // column ASKED this round failed and no other visible column holds an answer (status
        // 'done') — a not-signed-in column on the first SEND or a column skipped by a 전체
        // follow-up holds none, so the banner still fires there. NOT when a non-target column
        // still holds an answer: a single-column retry (「이 열만 다시 보내기」 leaves the other
        // columns untouched) that fails shows its own inline error + retry in that column — the
        // page-level 「어느 AI에서도」 banner was wrong there (2026-09-21 user report: one Gemini
        // retry failed while Claude/ChatGPT had answered).
        const live = state.roundTargets.map((p) => state.columns.get(p)).filter((c) => c && !c.node.hidden);
        const answeredElsewhere = [...state.columns.values()].some((c) => !c.node.hidden && !state.roundTargets.includes(c.id) && c.status === 'done');
        if (live.length && !answeredElsewhere && live.every((c) => c.status === 'error') && live.some((c) => c.errorCode !== CODE_ABORTED)) {
          ctx.showNotice('error', [t('all_failed'), t('all_failed_desc')]);
        }
        if (live.length) {
          const skipped = [...state.columns.values()].filter((c) => !c.node.hidden && !state.roundTargets.includes(c.id) && c.turns.length && c.turns[c.turns.length - 1].role === 'skipped').length;
          track('round_done', { ok_n: live.filter((c) => c.status === 'done').length, err_n: live.filter((c) => c.status === 'error').length, skipped_n: skipped, ms: state.roundStartedAt == null ? -1 : Math.max(0, clock.now() - state.roundStartedAt) });
        }
        finishSend();
        return;
      }
      default:
    }
  }

  function renderConsumeFail(msg) {
    const status = Number(msg.status);
    if (status === HTTP_TOO_MANY && msg.code === CODE_COMPARE_QUOTA) {
      track('quota_exhausted', {});
      if (state.roundGen !== state.quotaGen) { ctx.refreshQuota(); return; } // a 429 decided before a beta reset (§5): the fresh read says whether it still holds — no snapshot, no notice, and NO epoch bump (a fresh status read in flight must land — 2R)
      // The 429 IS a counted answer (Codex U3 1R #1): the server debited nothing because the
      // free count is at 0 — so the page's quota becomes that count from the message, whatever
      // it held before (null after a failed read, a stale pro:true, another limit). Building only
      // `remaining` onto the old object left the send open (quota null) or a Premium badge up.
      const prev = state.status.quota || {};
      state.status.quota = {
        remaining: 0,
        limit: Number.isFinite(msg.limit) ? msg.limit : (Number.isFinite(prev.limit) ? prev.limit : null),
        resetsAt: msg.resetsAt || prev.resetsAt || null,
        pro: false,
      };
      state.status.quotaError = null;
      ctx.bumpStatusEpoch();
      ctx.renderQuota(state.status.quota, null);
      // During the beta the reset offer (renderQuota above just showed it) is the action, not Premium.
      ctx.showNotice('warn', [ctx.quotaExhaustedTitle(msg.resetsAt)], ctx.betaReset() ? null : ctx.proCta(), NOTICE_OWNER_QUOTA);
      return;
    }
    if (status === HTTP_TOO_MANY) { ctx.showNotice('error', [t('err_rate_limited')]); return; }
    if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) {
      state.status.loggedIn = false;
      ctx.showNotice('warn', [t(msg.code === 'scope_insufficient' ? 'err_scope_insufficient' : 'login_required'), t('login_required_desc')], ctx.loginCta(), NOTICE_OWNER_LOGIN);
      return;
    }
    if (status === HTTP_NOT_FOUND) { ctx.renderComingSoon(); return; }
    if (msg.code === CODE_NO_TARGETS) { ctx.showNotice('error', [t('err_no_targets')]); return; }
    if (msg.code === CODE_BUSY) { ctx.showNotice('warn', [t('err_busy')]); return; }
    if (msg.code === CODE_NETWORK_ERROR) { ctx.showNotice('error', [t('err_network_error')]); return; }
    if (msg.code === CODE_ABORTED) { ctx.showNotice('warn', [t('consume_aborted')]); return; }
    if (msg.code === CODE_SESSION_ENDED) { ctx.showNotice('warn', [t(state.idleEnded ? 'session_idle_ended' : 'session_ended')]); return; }
    if (msg.code === CODE_SEND_FAILED) { ctx.showNotice('error', [t('send_failed')]); return; }
    ctx.showNotice('error', [msg.message ? `${t('err_generic')} (${msg.message})` : t('err_generic')]);
  }

  function closePort() {
    stopKeepalive();
    // 🔴 THE LINK BELONGS TO THE PORT (Codex 3/3 1R blockers 4 and 5). The receipt on screen is a
    // claim about what the WORKER is holding, and the worker holds it per port: when the port goes,
    // `pendingLink` goes with it. A receipt that outlives its port promises a continuation the next
    // SEND cannot deliver — the worker answered `bad_request` while the chip still said the old
    // conversation was being continued — and a read in flight became 「불러오는 중…」 forever.
    if (state.link || state.linkReading || state.linkError || state.linkOffer) {
      if (state.linkReading) state.linkError = linkErrorText('', null);
      const keepError = state.linkError;
      ctx.clearLink();
      state.linkError = keepError;      // clearLink() wipes it; the reason for the loss stays
      ctx.renderAttachment();
    }
    const port = state.port;
    const listener = portListener;
    state.port = null;
    portListener = null;
    if (!port) return;
    if (listener && port.onMessage && typeof port.onMessage.removeListener === 'function') { try { port.onMessage.removeListener(listener); } catch { /* already gone */ } }
    try { port.disconnect(); } catch { /* already gone */ }
  }

  /**
   * One port per session. The SW keeps the provider clients for the port's lifetime and disposes
   * them on disconnect, so a session whose port is gone cannot be continued on it — a fresh port
   * with a FOLLOWUP as its first message would be a contract violation (Codex #6). The one way
   * on after a lost port is a KEPT session with continuations (D3, canResume()): then a fresh port
   * is opened and beginSend() makes its first message SEND{resume}. Returns null when the session
   * is over; callers must not send.
   */
  let portListener = null;
  function ensurePort() {
    if (state.port) return state.port;
    if (state.disabled) return null;
    if (state.sessionStarted && !ctx.canResume()) return null;
    let port;
    // connect() throws when the extension context is gone (update/reload); there is no disconnect
    // event to clean up after, so the caller treats null as "send failed" (Codex 2R #27).
    try { port = chrome.runtime.connect({ name: COMPARE_PORT_NAME }); } catch { return null; }
    // 🔴 Pinned to THIS port: a message that arrives after closePort() (새 대화, then a new SEND on
    // a new port) must not paint the old answer into the new session's columns or settle its
    // round. The listener is also removed on close, but the identity check is what the guard
    // proves — the removal is belt-and-braces (Codex 1R #1).
    const listener = (msg) => {
      if (state.port !== port) return;
      // For the port-loss diagnostic: when and what the SW last said on this port.
      lastMessageAt = clock.now();
      lastMessageType = msg && typeof msg.type === 'string' ? msg.type : '';
      onPortMessage(msg);
    };
    portListener = listener;
    lastMessageAt = null; lastMessageType = ''; lastPingAt = null; // the diagnostic describes THIS port only
    port.onMessage.addListener(listener);
    port.onDisconnect.addListener(() => settlePortLoss(port));
    state.port = port;
    return port;
  }
  /**
   * The port died under us (the SW's disconnect event, or a PING that threw): settle the page.
   * Idempotent per port — `state.port` is nulled on the first call, so the disconnect event
   * arriving after a thrown PING (or vice versa) settles nothing twice.
   */
  function settlePortLoss(port) {
    {
      if (state.port !== port) return; // closed by us (closePort) or already settled — nothing to do
      state.port = null;
      stopKeepalive();
      // The link went with the port — see closePort(). A read in flight becomes a refusal the user
      // can act on instead of a spinner that never ends.
      if (state.link || state.linkReading || state.linkError || state.linkOffer) {
        const reading = state.linkReading;
        ctx.clearLink();
        if (reading) { state.linkError = linkErrorText('', null); ctx.renderAttachment(); }
      }
      // ONE line so a 「연결이 끊겨…」 seen in the wild can be read: a large sinceLastMessageMs with
      // idleEnded = the SW went idle by design; a small one = the SW restarted / the context died.
      const now = clock.now();
      const sinceLastMessageMs = lastMessageAt == null ? null : now - lastMessageAt;
      if (con && typeof con.info === 'function') {
        try {
          con.info('[compare] port lost', {
            at: new Date(now).toISOString(),
            sinceLastMessageMs,
            lastMessageType,
            sinceLastPingMs: lastPingAt == null ? null : now - lastPingAt,
            idleEnded: state.idleEnded,
            sessionStarted: state.sessionStarted,
          });
        } catch { /* a console that throws must not stop the settlement */ }
      }
      // Died before consume — a first SEND, or a SEND{resume} on its fresh port (D3): nothing was
      // sent and the SW keeps no clients for it. Roll the round back completely so a retry starts
      // clean — leaving `participated` turns behind let a later FOLLOWUP name a provider the new
      // session never sent to (Codex 2R #29). A resume that dies this way stays resumable.
      if (!state.sessionStarted || state.resuming) {
        const wasResuming = state.resuming;
        state.resuming = false;
        if (state.sending) {
          onPortMessage({ type: 'CONSUME_FAIL', status: 0, code: CODE_SEND_FAILED });
          // v1 contract gap: the SW may have debited and died before CONSUME_OK reached us. The
          // page cannot know, so it re-reads the server's count — the quota line self-corrects
          // instead of claiming "not counted" against a remaining that already dropped.
          ctx.refreshQuota();
        }
        if (wasResuming) track('session_lost', { idle: false, since_ms: sinceLastMessageMs == null ? -1 : sinceLastMessageMs, last_type: lastMessageType, resumable: ctx.canResume() });
        return;
      }
      // A round on the wire but not yet acknowledged — a FOLLOWUP (a 「요약·비교」 request included)
      // whose CONSUME_OK never came: the rollback snapshots (`col.round`) still stand. The SW died
      // between the send and its verdict, so on this side nothing happened: the optimistic turns
      // come off exactly as on CONSUME_FAIL (a folded request left behind with a dead answer turn
      // would be re-attached by the next comparison — Codex C5 2R #3), and whether the compare was
      // debited is unknowable here, so the count is re-read from the server (same v1 gap as above).
      if (state.sending && [...state.columns.values()].some((c) => c.round)) {
        onPortMessage({ type: 'CONSUME_FAIL', status: 0, code: CODE_SESSION_ENDED });
        ctx.refreshQuota();
      }
      // SW went away mid-session: settle every streaming column as disconnected, end the session.
      for (const col of state.columns.values()) {
        if (col.status === 'streaming') onPortMessage({ type: 'ERROR', col: col.id, provider: col.provider, code: 'bridge_disconnected', message: '' });
      }
      state.sessionEnded = true;
      // A KEPT session with continuations is not over (D3): the notice says a follow-up picks it
      // up, and updateControls() (finishSend) leaves the composers enabled for it. Otherwise it is
      // the dead end 새 대화 leads out of.
      const resumable = ctx.canResume();
      if (resumable) ctx.showNotice('info', [t('session_lost_resumable')]);
      else ctx.showNotice('warn', [t(state.idleEnded ? 'session_idle_ended' : 'session_ended')]);
      track('session_lost', { idle: state.idleEnded, since_ms: sinceLastMessageMs == null ? -1 : sinceLastMessageMs, last_type: lastMessageType, resumable });
      finishSend();
    }
  }

  // ── keepalive (see the MV3 note at PORT_MSG_PING) ──
  let keepaliveTimer = null;
  let lastActivityAt = clock.now();
  // Port-loss diagnostic bookkeeping (see settlePortLoss): the last SW message on the live port,
  // and the last PING the page posted.
  let lastMessageAt = null;
  let lastMessageType = '';
  let lastPingAt = null;
  const keepaliveWanted = () => !!state.port && state.sessionStarted && !state.sessionEnded && !state.disabled;
  function startKeepalive() {
    if (keepaliveTimer != null || !keepaliveWanted()) return;
    keepaliveTimer = clock.setInterval(tickKeepalive, KEEPALIVE_MS);
  }
  function stopKeepalive() {
    if (keepaliveTimer == null) return;
    clock.clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
  function tickKeepalive() {
    if (!keepaliveWanted()) { stopKeepalive(); return; }
    // The cap never fires while a round is in flight (a long answer is not idleness — the
    // countdown starts when the round settles, finishSend), and the SW keeps answering us anyway.
    if (!state.sending && clock.now() - lastActivityAt >= KEEPALIVE_MAX_IDLE_MS) {
      // Nobody has touched the page for KEEPALIVE_MAX_IDLE_MS: let the SW go. The session dies
      // by itself a little later, and the notice then says why (idle copy).
      state.idleEnded = true;
      stopKeepalive();
      return;
    }
    ping();
  }
  /** One PING on the live port; a throw means the port is already gone → settled as a disconnect. */
  function ping() {
    const port = state.port;
    lastPingAt = clock.now();
    try { port.postMessage({ type: PORT_MSG_PING }); } catch {
      // The SW's own disconnect event, if it still comes, finds `state.port` cleared and does nothing.
      settlePortLoss(port);
    }
  }
  /**
   * User activity: the idle clock restarts. A keepalive the cap had stopped resumes while the
   * session is still there — with a PING right now, not KEEPALIVE_MS from now: the last PING may
   * be almost 30 s old and the SW about to expire (Codex ka 1R #1).
   */
  function noteActivity() {
    lastActivityAt = clock.now();
    if (state.idleEnded && keepaliveWanted()) {
      state.idleEnded = false;
      startKeepalive();
      ping();
      return;
    }
    startKeepalive();
  }

  /**
   * `skipped`: participating columns that 「전체」 leaves out because they errored (AC21) — they get
   * the user turn plus a 「건너뜀」 marker. An individual follow-up touches only its target.
   */
  // `kind` (C5): TURN_KIND_SUMMARY for a 「요약·비교」 FOLLOWUP — the turns it draws carry it; the wire is the same.
  // `summary` (C5): the structured 「요약·비교」 request the summary turn keeps (see pushUserTurn `extra`).
  // `round` (C5 provenance): the round the turns belong to — a retry passes the round it repeats;
  // null = a new round (the composer's SEND / FOLLOWUP, a summary) bumps state.roundSeq.
  // `retry` (beta stats): this send repeats an earlier one (retryColumn — the plain and the Auto
  // retry) — its wire `kind` is 'retry' whatever the turn kind; `round` is then always the
  // repeated round (retryPair offers nothing for a turn without one).
  // `via` (chat layout): SEND_VIA_COLUMN when the text came from a column's own composer — analytics only.
  function beginSend(text, targets, type, skipped = [], kind = null, summary = null, round = null, retry = false, via = null) {
    ctx.clearNotice();
    state.sending = true;
    state.roundTargets = targets.slice();
    state.roundStartedAt = clock.now();
    // A follow-up on a lost-but-resumable session (D3): the page treats it like a FOLLOWUP (user
    // turns pushed, columns kept) while the wire gets a first-message SEND{resume} on a new port.
    const resume = type === 'FOLLOWUP' && ctx.canResume();
    if (resume) state.resuming = true;
    // What this send IS, for the wire (`kind`, cmp-beta-contract §3): a retry is a retry whatever
    // else it is; a summary is a summary even on a fresh port; the rest is the composer's SEND
    // (resume when it rides SEND{resume}) or FOLLOWUP.
    const sendKind = ctx.sendKindFor(type, kind, retry, resume);
    // The first round fixes the routing set at 「전체」 (every participant); C's checkboxes prune it.
    if (type === 'SEND') { state.followupTargets = new Set(targets); ctx.examples.hidden = true; }
    // 🔴 The SAME predicate the wire uses below (`carries`), needed here because the turns are
    // drawn before the message is built. Kept as one expression in `attachmentForRound` so the
    // two can never disagree — a marker on a round that sent no file is a lie, and a round that
    // sent one with no marker loses it from the history for good.
    const roundAtts = attachmentsForRound(state, sendKind, via);
    // The marker a turn keeps: the first file's name plus how many more (#1634). The whole list
    // would push a byte-capped history entry around for decoration; what a returning user needs is
    // «this question had images, starting with X».
    // `ids` (2026-09-26): one per image, so the turn can SHOW them again — the pictures live in the
    // image store (a preview started at attach, written to disk only by the history write), not here.
    // The id (and the preview) came with the attachment — see attachFile.
    const imgIds = roundAtts.map((a) => a.imageId || ctx.newSessionId());
    const imgMark = roundAtts.length ? { name: roundAtts[0].name, bytes: roundAtts[0].bytes, ...(roundAtts.length > 1 ? { more: roundAtts.length - 1 } : {}), ids: imgIds } : null;
    if (type === 'SEND') state.questionImg = imgMark; // the first round's question is the bubble, not a turn
    // The session id exists from the FIRST message out (it rides the wire, §5) — the same id the
    // history entry gets at CONSUME_OK; 새 대화 drops it and the next first SEND mints a new one.
    if (!state.sessionId) state.sessionId = ctx.newSessionId();
    state.roundGen = state.quotaGen;
    // This round's id, on every turn it draws (a rolled-back round leaves no turn, so no gap matters).
    if (!Number.isFinite(round)) round = ++state.roundSeq;
    state.roundInFlight = round;
    for (const col of state.columns.values()) {
      if (col.node.hidden) continue;
      // Snapshot for the CONSUME_FAIL rollback: nothing was sent, so nothing should remain drawn.
      // A new attempt: last time's readiness reason is no longer this column's state (it is kept
      // only until the user acts on it — a fresh SEND is acting on it). 🔴 The ERROR STATE it put
      // the column in goes with it, and BEFORE the snapshot below: otherwise the next rollback
      // restores a column that says 「실패」 with no reason under it, because the reason was
      // cleared and the badge was not.
      if (col.readiness) {
        col.readiness = null;
        col.status = 'idle';
        col.errorCode = null;
        col.errorTitle = '';
        col.badgeKey = null;
        col.badgeCls = '';
      }
      col.round = { turns: col.turns.length, status: col.status, errorCode: col.errorCode, errorTitle: col.errorTitle, badgeKey: col.badgeKey, badgeCls: col.badgeCls, servedModel: col.servedModel, stages: col.stages };
      if (targets.includes(col.id)) {
        col.participated = true;
        // The first round's question is the prompt card above — shown once; follow-ups repeat theirs.
        if (type !== 'SEND') ctx.pushUserTurn(col, text, kind, { round, summary, ...(imgMark ? { img: imgMark } : {}) });
        ctx.pushAssistantTurn(col, kind, { round });
      } else if (skipped.includes(col.id)) {
        ctx.pushUserTurn(col, text);
        ctx.pushSkippedTurn(col);
      }
    }
    ctx.updateControls();
    const port = ensurePort();
    if (!port) { // session over / page disabled / context gone — undo the optimistic turns
      state.resuming = false;
      onPortMessage({ type: 'CONSUME_FAIL', status: 0, code: state.sessionStarted ? CODE_SESSION_ENDED : CODE_SEND_FAILED });
      return;
    }
    let msg;
    if (type === 'SEND') {
      msg = { type: 'SEND', text, targets, mayOpenTab: true, saveHistory: !!state.saveHistory };
      // The pasted conversation this round continues (#1651). The worker holds both halves — the
      // continuation for the link's own column and the transcript for the others — so the page says
      // only WHETHER to use them, and in which language the frame should be written.
      if (state.link) { msg.useLink = true; msg.lang = ctx.lang; }
      // 🔴 A link turned 「시크릿 대화」 off FOR this session only (clearLink puts it back): the SW
      // must not keep that as the user's preference (1.35.0 batch review — #1655 × #1661: a user who
      // browses incognito by default lost that default to one pasted link).
      if (state.linkHistoryForced) msg.saveHistoryOnce = true;
    }
    else if (resume) {
      // EVERY continuation the page holds, not just the targets': the SW keeps the unused seeds
      // until each provider's client is constructed, so a column first asked in a LATER
      // follow-up still continues its own conversation (batch-3 Codex #1). saveHistory is
      // true by construction — only a kept session is resumable.
      const cont = {};
      for (const c of ctx.liveColumns()) if (c.continuation) cont[c.id] = c.continuation;
      // saveHistoryOnce: the `true` is this resumed session's (only a kept one resumes), not a new
      // preference — same defect as the link's, reached by continuing a history entry.
      msg = { type: 'SEND', text, targets, mayOpenTab: true, saveHistory: true, saveHistoryOnce: true, resume: cont };
    } else msg = { type: 'FOLLOWUP', text, targets };
    // Beta stats (cmp-beta-contract §3 / §5): the kind, the round, the validated source provider
    // (omitted when the page was opened without one) and the session id, on every wire message.
    msg.kind = sendKind;
    msg.round = round;
    // The round's image (#1617), `{name, type, data}` as bg/compare.js normalizes it — `bytes` is
    // the page's own bookkeeping for the chip and has no meaning on the other side. The key is
    // omitted when there is no file, so a round without one is the message it has always been.
    //
    // 🔴 THE FILE GOES WITH THE BOX IT SITS ABOVE, and with nothing else. A summary, a retry and a
    // column's own follow-up are rounds the user did NOT choose a file for: the tray is the dock's,
    // and the chip is still showing because it is waiting for the dock's next question. Putting it
    // on any of them re-uploads the same image and charges a compare for it — the same family of
    // defect as the #1616 review's "the attachment repeats on every follow-up", which passed 619
    // checks because no test had a round WITHOUT one before a round WITH one.
    const carries = roundAtts.length > 0;
    if (carries) msg.attachments = roundAtts.map((a) => ({ name: a.name, type: a.type, data: a.data }));
    // Only a round that actually CARRIED it may consume it at CONSUME_OK (below); otherwise a
    // summary accepted while a file waits would swallow a file that never left the page.
    state.roundOwnsTray = roundOwnsTray(sendKind, via);
    if (src) msg.src = src;
    if (typeof state.sessionId === 'string' && SESSION_ID_RE.test(state.sessionId)) msg.session = state.sessionId;
    // The columns of this send (cmp-columns contract §1): `{id, provider, model}` each — the SW
    // builds one client per column from it and persists the choices to `compareModels`. `columns[]`
    // is the ONLY model source on the wire (the SW ignores a legacy `models` map); `models` below
    // feeds the GA csv only.
    msg.columns = ctx.columnsFor(targets);
    const models = ctx.modelsFor(targets);
    // `models` = ids only (never labels), one `provider:id|auto` per target, in target order.
    // GA `targets` stays the PROVIDER list (a colId carries the model id, which only `models` puts on the wire — validated); `targets_n` counts columns.
    track('send', { round: state.rounds + 1, targets_n: targets.length, targets: targets.map((id) => (state.columns.get(id) || {}).provider || id).join(','), save_history: type === 'SEND' ? !!state.saveHistory : state.sessionSaveHistory === true, followup: type !== 'SEND', resume, kind: sendKind, models: ctx.modelsCsv(targets, models), has_img: carries, ...(via ? { via } : {}) });
    // The pickers this page still shows as static/none (#1452 refresh): the SW re-lists exactly these
    // once the tabs exist and answers with MODELS, which updates this list.
    const targetProviders = new Set(targets.map((id) => (state.columns.get(id) || {}).provider));
    const pending = Array.isArray(state.status?.modelsPending) ? state.status.modelsPending.filter((p) => typeof p === 'string' && targetProviders.has(p)) : [];
    if (pending.length) msg.modelsPending = pending;
    try {
      port.postMessage(msg);
    } catch {
      closePort();
      onPortMessage({ type: 'CONSUME_FAIL', status: 0, code: CODE_SEND_FAILED });
    }
  }

  function finishSend() {
    state.sending = false;
    lastActivityAt = clock.now(); // the idle countdown starts when the round settles, not when it began
    ctx.stopBtn.disabled = true;
    ctx.syncWaitTimer();
    ctx.updateControls();
    ctx.persistSession(); // every settled round updates the local history entry (kept sessions only)
  }

  function currentTargets() {
    if (state.disabled || !state.status || !state.status.loggedIn) return [];
    const providers = new Set(sendableTargets(state.status, src, state.excludeSrc));
    return ctx.allColumns().filter((c) => providers.has(c.provider) && !c.node.hidden).map((c) => c.id);
  }
  // Everything another file reaches (compare.js destructures the names it calls bare).
  /** Ask the worker to read a pasted conversation (#1651). A read debits nothing. */
  function sendReadLink(url) {
    const port = ensurePort();
    const failed = () => { state.linkReading = false; state.linkError = linkErrorText('', null); ctx.renderAttachment(); ctx.updateControls(); };
    if (!port) { failed(); return; }
    try { port.postMessage({ type: 'READ_LINK', url, mayOpenTab: true }); } catch { failed(); }
  }

  Object.assign(ctx, {
    columnForMsg, onPortMessage, renderConsumeFail, closePort, ensurePort, settlePortLoss, keepaliveWanted, startKeepalive,
    stopKeepalive, tickKeepalive, ping, noteActivity, beginSend, finishSend, currentTargets, sendReadLink,
  });
}
