// === Constants & Configuration ===

export const DEFAULT_SERVER_URL = 'https://api.claudetuner.com';
export const DEFAULT_API_KEY = 'claude-manager-dev-key-2024';
export const SITE_URL = 'https://claudetuner.com';

export const ALARM_NAME = 'claude-usage-poll';
export const ALARM_EXPIRE_PREFIX = 'claude-expire-';
export const ALARM_BOOST = 'claude-boost-poll';
export const ALARM_WEEKLY_REPORT = 'weekly-report';
export const ALARM_REC = 'claude-rec-poll';

export const DEFAULT_INTERVAL_MINUTES = 10;
export const FREE_PLAN_INTERVAL_MINUTES = 60;

// Activity-aware local polling intervals (server POST gated separately)
export const LOCAL_ACTIVE_INTERVAL_MINUTES = 2;
export const LOCAL_BACKGROUND_INTERVAL_MINUTES = 5;
export const VISIBILITY_THROTTLE_MS = 30_000;
export const POPUP_COLLECT_THROTTLE_MS = 60_000;
export const CLAUDE_API_BASE = 'https://claude.ai';
export const CHATGPT_API_BASE = 'https://chatgpt.com';
export const CHATGPT_SESSION_COOKIE = '__Secure-next-auth.session-token';
export const GEMINI_API_BASE = 'https://gemini.google.com';
export const HEARTBEAT_INTERVAL_MS = 1 * 60 * 60 * 1000; // 1 hour
// Backoff after a heartbeat that did NOT land. The interval above is the SUCCESS cadence; a
// heartbeat the server never received must not consume it (#980 — see bg/heartbeat.js for why the
// bias is one-directional). Capped at HEARTBEAT_INTERVAL_MS by heartbeatRetryDelayMs so a
// permanently-rejected install can never exceed the request rate it already has today.
export const HEARTBEAT_RETRY_BASE_MS = 5 * 60 * 1000; // 5 min after the 1st failed delivery
// Abort a heartbeat that never answers. Awaiting the request is what keeps the MV3 service worker
// alive long enough to flush it, so an unbounded hang would stall the alarm handler that awaits
// collectAndSend — the timeout is the price of awaiting.
export const HEARTBEAT_TIMEOUT_MS = 10_000;
export const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (for Enterprise spending monthly chart)

export const PLAN_HIERARCHY = ['Pro', 'Max 5x', 'Max 20x'];

// USD/month list price per plan. Used to show the user what a plan change costs BEFORE they
// confirm it (popup plan confirmation modal), so it must stay in sync with Anthropic's pricing.
export const PLAN_MONTHLY_COST_USD = { 'Pro': 20, 'Max 5x': 100, 'Max 20x': 200 };

export const PLAN_API_MAP = {
  'Pro': 'pro_monthly',
  'Max 5x': 'max_5x_monthly',
  'Max 20x': 'max_20x_monthly',
};

export const SEAT_TIER_MAP = { 'team_standard': 'Team Standard', 'team_tier_1': 'Team Premium', 'team_tier_2': 'Team Tier 2' };

// Display names for the three collected services. Was hand-copied in background.js and
// ui/org-selector.js; a third copy (bg/notifications.js) is what prompted the merge. Not i18n keys
// on purpose — these are product names and read the same in every locale.
// PROVIDER_ORDER fixes the sequence wherever several are listed together, so the wording does not
// change with whatever order collection happened to write into `collectedOrgs`.
export const PROVIDER_LABELS = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' };
export const PROVIDER_ORDER = ['claude', 'chatgpt', 'gemini'];

// Client headers required for Claude.ai API requests
export const ANTHROPIC_HEADERS = { 'anthropic-client-platform': 'web_claude_ai', 'anthropic-client-version': '1.0.0' };

// Plans that are NOT personal (no subscription API access)
export const NON_PERSONAL_PLANS = ['Enterprise', 'Team', 'Team Standard', 'Team Premium', 'Team Tier 2', 'API'];

export const NOTIF_ID_OPTIMIZE = 'claude-plan-optimize';

// executePlanChange's verdict when the plan on claude.ai no longer matches the one the
// recommendation was computed for. Produced by bg/plan.js, consumed by bg/plan.js and popup.js —
// a value that crosses module boundaries, so it is not a literal repeated at each end.
export const ERR_PLAN_CHANGED_EXTERNALLY = 'Plan already changed externally';
export const NOTIF_ID_ALERT = 'usage-alert';

// === Adaptive Polling for secondary orgs ===
export const ORG_POLL_TIERS = {
  active:  { intervalMs: 0,                  promoteAfter: 6 },  // every alarm cycle (5min), promote after 30min unchanged
  idle:    { intervalMs: 30 * 60 * 1000,     promoteAfter: 6 },  // 30min, promote to dormant after 3h unchanged
  dormant: { intervalMs: 2 * 60 * 60 * 1000, promoteAfter: Infinity }, // 2h, stays dormant
};
export const ORG_POLL_TIER_ORDER = ['active', 'idle', 'dormant'];
export const ORG_POLL_CHANGE_THRESHOLD = 0.1; // utilization pp change to consider "changed"

// === Delta-gated server send (primary org) ===
// Local collection/history still runs every alarm tick (popup stays fresh);
// we only gate the SERVER POST: send when usage changed (and >= MIN_INTERVAL
// since the last POST), or force a flat heartbeat every FLOOR. This both cuts
// snapshot INSERTs and avoids the wasted POST+read the server-side dedup would
// otherwise do. FLOOR (1h) must stay < the server disconnection-email gate
// (6h — index.ts, "skip if any Claude snapshot landed within the last 6 hours")
// and < the dashboard chart gap CLAUDE_GAP_MS (140min),
// and >= the server unchanged-usage dedup window (60min) so heartbeats aren't
// deduped away. Do NOT remove the floor — it is the liveness signal.
export const SEND_HEARTBEAT_FLOOR_MS = 60 * 60 * 1000; // 1h: force-send even if unchanged
export const SEND_MIN_INTERVAL_MS = 10 * 60 * 1000;    // 10min: suppress rapid changed re-sends
// Server-failure backoff: when /api/snapshots returns 5xx (server/D1 overload) or
// the POST fails at the network layer, exponentially back off the SERVER POST so a
// sustained outage isn't retried every SEND_MIN_INTERVAL tick (the retry-on-5xx
// rollback added in #228/#233 otherwise hammers the server exactly when it's
// already saturated — 2026-06-18 read-saturation incident). The first failure
// backs off BASE (= one normal interval, same as today's next-tick retry); only
// CONSECUTIVE failures escalate (BASE, 2×, 4×, … up to CAP). CAP stays < the chart
// gap CLAUDE_GAP_MS (140min) and the 6h disconnection-email gate so even at max
// backoff a client resumes well before any false "수집 끊김" / disconnection email.
export const SERVER_BACKOFF_BASE_MS = SEND_MIN_INTERVAL_MS; // 10min
export const SERVER_BACKOFF_CAP_MS = 60 * 60 * 1000;       // 60min

// Upgrade-required (426) backoff — bg/upgrade-gate.js. A DIFFERENT problem from the 5xx backoff
// above, so a different ladder: a 5xx is transient and the server wants us back soon, while a 426
// cannot resolve until the USER updates the extension. Retrying that on the 10min ladder is pure
// waste at both ends, so BASE starts far higher and CAP is deliberately allowed past the
// 6h disconnection-email gate — a version-blocked install genuinely IS disconnected, and pretending
// otherwise by probing under the gate would only manufacture load, not data.
// CAP is a PROBE interval, not a give-up: MIN_INGEST_VERSION / _MODE are env knobs that can be
// lowered without a release, so a client that stopped forever would stay dead after the server had
// already forgiven it. A user-driven update recovers instantly instead (version-keyed, no wait).
export const UPGRADE_BACKOFF_BASE_MS = 30 * 60 * 1000;     // 30min
export const UPGRADE_BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;  // 6h

// authBlocked (email-provider guard 401 login_required) backoff — bg/storage.js. Same shape and
// same reasoning as the upgrade ladder: the block cannot resolve until the USER logs in, so the
// every-cycle retry it replaces was pure waste (measured 3,557 401/day, 2026-07-28). Kept as its
// own pair rather than reusing the UPGRADE_* values so the two can be tuned independently — they
// answer to different populations and different fixes.
// CAP is lower (2h) than the upgrade cap: logging in is a far lighter action than shipping and
// adopting a new extension build, so a blocked account is much more likely to fix itself soon,
// and the probe should not lag that by hours. Recovery does not actually wait for the probe —
// clearing `authBlocked` on login releases it immediately — so the cap only bounds the case where
// the block ends server-side without a login.
export const AUTH_BLOCK_BACKOFF_BASE_MS = 30 * 60 * 1000;     // 30min
export const AUTH_BLOCK_BACKOFF_CAP_MS = 2 * 60 * 60 * 1000;  // 2h

// === Token-withheld fast retry — bg/storage.js noteTokenWithheld ===
// The INVERSE of the two ladders above. Those slow a retry down because only the USER can end the
// block; this one speeds a retry UP because the block is transient server state that ends on its
// own. The server answers an api_key POST 200 with no `ext_token` when the [C1] guard's D1 read
// degrades (routes/snapshots.ts resolveEmailProviderGuard), and for a TOKENLESS install that
// response was its only supply — so it waits a full cycle holding nothing, for a condition that is
// usually over in seconds. See .omc/report-token-loss.md.
//
// 🔴 BASE is 1 minute because chrome.alarms clamps sub-minute delays in a packed extension — a
// 30s ladder would silently become a 1min one. Normal cadence is DEFAULT_INTERVAL_MINUTES (10) /
// SEND_MIN_INTERVAL_MS (10min), so 1→2→4min is a real speed-up, not a cosmetic one.
export const TOKEN_RETRY_BASE_MS = 60 * 1000;                 // 1min (alarm granularity floor)
export const TOKEN_RETRY_MAX_ATTEMPTS = 3;                    // 1min, 2min, 4min — then give up
// After the attempts are spent, stop probing for a while rather than restarting the ladder on the
// very next cycle. Without this a persistently degrading replica would turn every cycle into
// 3 extra forced POSTs, which is load amplification aimed at the exact D1 that is already sick.
export const TOKEN_RETRY_COOLDOWN_MS = 60 * 60 * 1000;        // 1h

// === Ad impression/click counter flush cadence (design §5.4) ===
// The background SW is the single owner of the ad counters; it flushes the batched
// impression/click deltas to /api/event on this alarm. Default 60min; the server can
// steer it fleet-wide via impression_flush_minutes (cadence-config.js), unclamped
// (type-validated only, like the send floor).
export const IMPRESSION_FLUSH_DEFAULT_MS = 60 * 60 * 1000; // 60min default

// === Server-tunable cadence (cadence-config.js) ===
// Collection (Claude/ChatGPT/Gemini fetch) and server POST cadence can be steered
// fleet-wide by the server (faster than a CWS release) for provider incidents
// (Claude outage / rate-limit change) and our own D1 load. Each parameter has a
// hardcoded default here so the extension ALWAYS works standalone; the server only
// OVERRIDES. Overrides decay back to these defaults after CADENCE_TTL_MS if the
// server can't reconfirm them — so an aggressive value can't persist if the server
// dies (this TTL-decay replaces clamps for the unclamped send floor).
export const COLLECT_HARD_FLOOR_MS = 5 * 60 * 1000;        // 5min: never collect faster, even at active tier (clamp kept — too-fast = provider ban risk)
export const HEARTBEAT_FLOOR_MIN_MS = 60 * 60 * 1000;      // heartbeat clamp lower bound (>= server 60min dedup window)
// 🪤 This bound used to cite a "3h skip" gate. There is no such gate: 3h was the OLD value of the
// disconnection-email skip, widened 1h → 3h (2026-06-04) → 6h (2026-06-14) — see the history comment
// at worker/src/index.ts. The retired value was left sitting next to its own replacement, which read
// as two independent gates and sent more than one person hunting for a 3h check that does not exist.
export const HEARTBEAT_FLOOR_MAX_MS = 140 * 60 * 1000;     // heartbeat clamp upper bound (< chart gap CLAUDE_GAP_MS 140min / 6h disconnection email) — exclusive
export const CADENCE_TTL_MS = 12 * 60 * 60 * 1000;         // 12h: a server override not reconfirmed within this decays to the hardcoded default
// (HISTORY_BACKFILL_COOLDOWN_MS lived here. It rate-limited the history backfill, which is
// retired — #1081. Its note is worth keeping as evidence: at idle/dormant cadence the 6h window
// structurally holds < 30 points, so the trigger was PERMANENTLY true for those installs. That is
// why it could not identify the people backfill was for, and why the cooldown had to exist at all
// — it was holding back a forced POST that fired on nearly everyone.)

// === Error classification ===
export const ACTIONABLE_ERRORS = ['err_session_expired', 'err_no_cookies', 'err_auth_failed'];

// === i18n (lightweight translations for service worker) ===
export const BG_I18N = {
  ko: {
    // #966 badge tooltip. 🔴 Twin of `pin_move_title` in the popup dictionary
    // (i18n.js) — separate runtimes, so the two copies are pinned identical by
    // test/pin-heal-guard.mjs.
    pin_move_title: '대표 조직이 변경되었습니다',
    // #994 unit 3 — TOOLBAR TOOLTIP ONLY. 🔴 Deliberately NOT twinned into the popup dictionary
    // (i18n.js). The pin_move_* keys above are twinned because the popup RENDERS that same text, so
    // the two copies can drift and a guard pins them. A tooltip is chrome.action.setTitle and has
    // no popup counterpart — adding one would manufacture the very twin problem the guard exists
    // to police. One runtime, one copy.
    tip_rec: '{0} → {1} 변경을 추천합니다',
    tip_order: '{0} → {1} 변경을 처리하고 있습니다',
    tip_blocked: '사용량이 서버에 저장되지 않고 있습니다 — 확장을 열어 확인해 주세요',
    reset_soon_title: '{0} 한도 곧 리셋',
    reset_soon_msg: '약 5분 후 {0} 사용량이 리셋됩니다. 큰 작업은 리셋 후에 시작하세요!',
    reset_soon_usage_prefix: '현재 {0}% 사용 중. ',
    reset_done_title: '{0} 한도 리셋 완료!',
    reset_done_msg: '{0} 사용량이 리셋되었습니다. 다시 마음껏 사용하세요!',
    alert_title: '사용량 {0}% 도달',
    alert_5h: '5시간 사용률이 {0}%에 도달했습니다.',
    alert_7d: '7일 사용률이 {0}%에 도달했습니다.',
    opt_done_title: '플랜 변경 완료',
    opt_done_msg: '{0} → {1} 변경이 완료되었습니다.',
    opt_fail_title: '플랜 변경 실패',
    opt_already_title: '플랜 변경 취소',
    opt_already_msg: '플랜이 이미 {0}(으)로 변경되었습니다.',
    opt_cancel_title: '다운그레이드 취소 완료',
    opt_cancel_msg: '기존 플랜({0})을 유지합니다.',
    po_title: '플랜 변경 요청',
    po_msg: '{0} 관리자가 {1} → {2} 변경을 요청했습니다.',
    po_accept: '변경하기',
    po_reject: '거절',
    weekly_title: '주간 사용 리포트',
    win_5h: '5시간',
    win_7d: '7일',
    cf_title: '수집 중단',
    cf_paused_title: '수집 일시 중단',
    cf_session_msg: '세션이 만료되었습니다. Claude.ai에 다시 로그인해주세요.',
    cf_transient_msg: 'Claude.ai 연결에 문제가 있습니다. 잠시 후 자동으로 재시도합니다.',
    cf_reminder_title: '수집 중단 ({0}시간째)',
    cf_final_title: '수집이 하루째 중단 중',
    cf_final_msg: '더 이상 알림을 보내지 않습니다. Claude.ai에 로그인하면 자동으로 재개됩니다.',
    cf_btn_open: 'Claude.ai 열기',
    cf_firstrun_title: 'Claude.ai 로그인 필요',
    cf_firstrun_msg: 'Claude.ai에 로그인해야 사용량 데이터를 수집할 수 있습니다.',
    notif_settings_hint: '확장 설정에서 알림을 관리할 수 있습니다.',
    notif_settings_btn: '설정',
    promo_push_btn: '자세히 보기',
    // 서버 동기화 차단(email-provider 가드 401). 팝업 CTA는 "팝업을 여는 사람"에게만 닿는데,
    // 이 확장은 원래 열어볼 일이 없는 물건이라 배지·알림이 유일하게 도달하는 표면이다.
    // 🔴 어휘 3원칙 (login_cta_* / reauth_* 와 동일하게 유지할 것):
    //   ① 인증의 주체를 반드시 밝힌다 — 맨 "로그인/인증"은 사용자가 방금 한 Claude 로그인으로
    //      읽힌다("클로드에 로그인했는데 이건 또 무슨 소리지"). 1회차는 Claude와 별개임을 명시한다.
    //   ② 로컬은 안전하다는 사실을 먼저 말한다. 종전 1회차는 "저장되지 않고 있습니다"로 시작해
    //      기록이 날아간 것처럼 읽혔다 — 실제로는 이 브라우저에 온전히 남아 있다.
    //   ③ "서버"는 써도 된다(제품 오너 확인). 한때 이 자리에 "개발자 어휘이니 피하라"고 적었다가
    //      3회차를 "여러 기기 사용량이 모여야 만들어집니다"로 바꿔 **없는 제약을 지어냈다** —
    //      트렌드·히트맵·예측은 서버 저장 기능이지 멀티기기 전용이 아니다. 🔴 어휘 선호가
    //      사실관계를 이길 수 없다. 아래 "실재 확인된 것만" 원칙이 항상 우선한다.
    authblocked_title: '사용량이 이 브라우저에만 쌓이고 있습니다',
    // 🔴 세 서비스를 모두 적는다. 이 인구는 멀티 프로바이더다(차단 백오프가 이메일별로 스코프된
    // 이유가 그것 — bg/storage.js). "Claude 로그인과는 별개"라고만 쓰면 ChatGPT만 쓰는 사람에겐
    // 무의미하고, 셋 다 쓰는 사람에게 하나만 고르면 나머지는 여전히 오해로 남는다. 감지된
    // 프로바이더를 넣는 방법도 있으나 멀티 프로바이더에서 답이 없다. 나열이 항상 참이다.
    // 🔑 절의 순서는 잘림을 전제로 정했다. Chrome 알림 본문은 몇 줄 뒤 잘리므로 주체와 "별개"를
    // 앞에, 복구 안내를 뒤에 뒀다 — 뒷절이 잘려도 버튼('지금 인증하기')이 행동을 대신한다.
    // 반대로 놓으면 이 문구가 존재하는 이유(그 오해를 푸는 것)가 먼저 잘린다. 절 추가는 반드시 뒤에.
    authblocked_msg: 'Claude Tuner 인증이 필요합니다 — {0} 로그인과는 별개이며, 이메일 인증 한 번이면 서버 저장이 다시 켜집니다.',
    authblocked_btn: '지금 인증하기',
    // 후속 사다리(2~4회차). 원칙: "인증하세요"로 시작하지 않고 손실/혜택을 먼저 말한다.
    // 여기 언급하는 기능은 전부 실재 확인된 것만 쓸 것 — "데이터 백업"이라는 기능은 없다(=서버 동기화).
    authblock_r2_title: '3일째 이 브라우저에만 쌓이고 있습니다',
    authblock_r2_msg: 'Claude Tuner 인증 한 번이면 여러 브라우저·기기의 사용량이 하나로 합쳐지고, 내 사용 패턴에 맞는 플랜 추천을 받을 수 있습니다.',
    authblock_r3_title: '지난 10일치 분석을 놓치고 있습니다',
    authblock_r3_msg: '주별 트렌드·시간대별 히트맵·7일 예측은 Claude Tuner에 저장된 사용량으로 만들어집니다. 인증 한 번이면 됩니다.',
    // 🔴 마지막 회차는 "다시 알리지 않겠다"를 반드시 명시한다 — 끝난다는 걸 아는 것 자체가 분노를 크게 낮춘다.
    authblock_r4_title: '마지막 안내입니다',
    authblock_r4_msg: '인증하지 않으면 사용량은 이 브라우저에서만 볼 수 있습니다. 다시 알리지 않겠습니다 — 필요하면 확장 아이콘을 눌러 언제든 Claude Tuner 인증을 할 수 있습니다.',
  },
  en: {
    // #966 badge tooltip. 🔴 Twin of `pin_move_title` in the popup dictionary
    // (i18n.js) — separate runtimes, so the two copies are pinned identical by
    // test/pin-heal-guard.mjs.
    pin_move_title: 'Your primary organization changed',
    // #994 unit 3 — toolbar tooltip only; see the note on the Korean side.
    tip_rec: 'Consider moving from {0} to {1}',
    tip_order: 'Changing from {0} to {1}…',
    tip_blocked: 'Your usage is not reaching the server — open the extension to fix it',
    reset_soon_title: '{0} limit resetting soon',
    reset_soon_msg: '{0} usage will reset in ~5 minutes. Start big tasks after the reset!',
    reset_soon_usage_prefix: 'Currently at {0}%. ',
    reset_done_title: '{0} limit reset!',
    reset_done_msg: '{0} usage has been reset. Use freely!',
    alert_title: 'Usage reached {0}%',
    alert_5h: '5-hour usage reached {0}%.',
    alert_7d: '7-day usage reached {0}%.',
    opt_done_title: 'Plan changed',
    opt_done_msg: 'Changed from {0} to {1}.',
    opt_fail_title: 'Plan change failed',
    opt_already_title: 'Plan change cancelled',
    opt_already_msg: 'Plan is already changed to {0}.',
    opt_cancel_title: 'Downgrade cancelled',
    opt_cancel_msg: 'Keeping current plan ({0}).',
    po_title: 'Plan change request',
    po_msg: '{0} admin requested a change from {1} to {2}.',
    po_accept: 'Apply',
    po_reject: 'Decline',
    weekly_title: 'Weekly Usage Report',
    win_5h: '5-hour',
    win_7d: '7-day',
    cf_title: 'Collection stopped',
    cf_paused_title: 'Collection paused',
    cf_session_msg: 'Session expired. Please sign in to Claude.ai again.',
    cf_transient_msg: 'Connection issue with Claude.ai. Will retry automatically.',
    cf_reminder_title: 'Collection stopped ({0}h)',
    cf_final_title: 'Collection stopped for 24 hours',
    cf_final_msg: 'No further alerts. Collection resumes when you sign in to Claude.ai.',
    cf_btn_open: 'Open Claude.ai',
    cf_firstrun_title: 'Claude.ai sign-in required',
    cf_firstrun_msg: 'Please sign in to Claude.ai so the extension can collect your usage data.',
    notif_settings_hint: 'Manage alerts in extension settings.',
    notif_settings_btn: 'Settings',
    promo_push_btn: 'View',
    // Server sync blocked (email-provider guard 401). The popup CTA only reaches someone who
    // opens the popup, and this extension is built to be ignored — the badge/notification is the
    // only surface that reaches a user who never opens it.
    // See the Korean block for the three copy rules: name WHO the verification is for (a bare
    // "sign in" reads as the Claude login the user just completed), lead with the fact that
    // nothing is lost locally, and prefer user-facing wording over "the server".
    authblocked_title: 'Your usage is only being saved on this browser',
    authblocked_msg: 'You need to verify Claude Tuner — separate from your {0} sign-in. One email verification turns server sync back on.',
    authblocked_btn: 'Verify now',
    authblock_r2_title: '3 days of usage saved only on this browser',
    authblock_r2_msg: 'Verify Claude Tuner once to merge usage across your browsers and devices, and to get plan recommendations based on how you actually use it.',
    authblock_r3_title: "You're missing 10 days of insights",
    authblock_r3_msg: 'Weekly trends, hourly heatmaps and 7-day forecasts are built from usage saved to Claude Tuner. One verification is all it takes.',
    authblock_r4_title: 'Last reminder',
    authblock_r4_msg: "Without verifying, your usage stays visible only on this browser. We won't remind you again — you can verify Claude Tuner any time from the extension icon.",
  },
};
