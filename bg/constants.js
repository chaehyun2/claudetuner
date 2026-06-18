// === Constants & Configuration ===

export const DEFAULT_SERVER_URL = 'https://api.claudetuner.com';
export const DEFAULT_API_KEY = 'claude-manager-dev-key-2024';
export const SITE_URL = 'https://claudetuner.com';

export const ALARM_NAME = 'claude-usage-poll';
export const ALARM_EXPIRE_PREFIX = 'claude-expire-';
export const ALARM_BOOST = 'claude-boost-poll';
export const ALARM_WEEKLY_REPORT = 'weekly-report';

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
export const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (for Enterprise spending monthly chart)

export const PLAN_HIERARCHY = ['Pro', 'Max 5x', 'Max 20x'];

export const PLAN_API_MAP = {
  'Pro': 'pro_monthly',
  'Max 5x': 'max_5x_monthly',
  'Max 20x': 'max_20x_monthly',
};

export const SEAT_TIER_MAP = { 'team_standard': 'Team Standard', 'team_tier_1': 'Team Premium', 'team_tier_2': 'Team Tier 2' };

// Client headers required for Claude.ai API requests
export const ANTHROPIC_HEADERS = { 'anthropic-client-platform': 'web_claude_ai', 'anthropic-client-version': '1.0.0' };

// Plans that are NOT personal (no subscription API access)
export const NON_PERSONAL_PLANS = ['Enterprise', 'Team', 'Team Standard', 'Team Premium', 'Team Tier 2', 'API'];

export const NOTIF_ID_OPTIMIZE = 'claude-plan-optimize';
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
// otherwise do. FLOOR (1h) must stay < the server disconnection gates
// (3h skip / 6h email) and < the dashboard chart gap CLAUDE_GAP_MS (140min),
// and >= the server unchanged-usage dedup window (60min) so heartbeats aren't
// deduped away. Do NOT remove the floor — it is the liveness signal.
export const SEND_HEARTBEAT_FLOOR_MS = 60 * 60 * 1000; // 1h: force-send even if unchanged
export const SEND_MIN_INTERVAL_MS = 10 * 60 * 1000;    // 10min: suppress rapid changed re-sends
// After a need_history backfill attempt, suppress re-triggering for this long. At a
// slow (idle/dormant) cadence the 6h history window structurally holds < 30 points, so
// needHistory would otherwise stay true forever and bypass the adaptive tier gate —
// pinning the primary org to active cadence and defeating the idle/dormant backoff.
export const HISTORY_BACKFILL_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h

// === Error classification ===
export const ACTIONABLE_ERRORS = ['err_session_expired', 'err_no_cookies', 'err_auth_failed'];

// === i18n (lightweight translations for service worker) ===
export const BG_I18N = {
  ko: {
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
  },
  en: {
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
  },
};
