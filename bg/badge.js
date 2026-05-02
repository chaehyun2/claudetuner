// === 배지 업데이트 (사용량 표시 모드 기반) ===
export async function updateBadge(util7d, util5h) {
  resetIcon(); // 에러 아이콘이었으면 정상 복원

  // 대기 중인 오더가 있으면 오더 아이콘 + 배지 우선 표시
  const { pendingPlanOrder } = await chrome.storage.local.get('pendingPlanOrder');
  if (pendingPlanOrder) {
    chrome.action.setIcon({ path: { 16: 'icons/icon16-order.png', 48: 'icons/icon48-order.png', 128: 'icons/icon128-order.png' } });
    chrome.action.setBadgeText({ text: '📋' });
    chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' });
    return;
  }

  const { usageDisplayMode = '7d', thresholdWarn = 80, thresholdDanger = 95 } = await chrome.storage.sync.get({ usageDisplayMode: '7d', thresholdWarn: 80, thresholdDanger: 95 });
  let util;
  if (usageDisplayMode === '5h') {
    util = util5h;
  } else if (usageDisplayMode === 'both') {
    // 둘 다일 때 높은 쪽 표시
    if (util5h != null && util7d != null) util = Math.max(util5h, util7d);
    else util = util7d ?? util5h;
  } else {
    util = util7d;
  }

  if (util === null || util === undefined) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }
  const pct = Math.round(util);
  chrome.action.setBadgeText({ text: pct + '%' });

  if (util >= thresholdDanger) {
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' }); // 빨강 (위험)
  } else if (util >= thresholdWarn) {
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' }); // 주황 (주의)
  } else {
    // 정상 범위: 5h=청록, 7d=보라로 구분
    const showing5h = usageDisplayMode === '5h' || (usageDisplayMode === 'both' && util5h != null && util7d != null && util5h >= util7d);
    chrome.action.setBadgeBackgroundColor({ color: showing5h ? '#06b6d4' : '#7c3aed' });
  }
}

// 수집 실패 시 에러 아이콘 + 배지
export function updateBadgeError() {
  chrome.action.setBadgeText({ text: '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  chrome.action.setIcon({
    path: { 16: 'icons/icon16-error.png', 48: 'icons/icon48-error.png', 128: 'icons/icon128-error.png' },
  });
}

// 정상 아이콘 복원
export function resetIcon() {
  chrome.action.setIcon({
    path: { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
  });
}
