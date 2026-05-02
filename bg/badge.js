// === Badge update (based on usage display mode) ===
export async function updateBadge(util7d, util5h) {
  resetIcon(); // Restore normal icon if it was showing error

  // If there's a pending order, show order icon + badge first
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
    // When showing both, display the higher value
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
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' }); // Red (danger)
  } else if (util >= thresholdWarn) {
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' }); // Orange (warning)
  } else {
    // Normal range: 5h=cyan, 7d=purple to distinguish
    const showing5h = usageDisplayMode === '5h' || (usageDisplayMode === 'both' && util5h != null && util7d != null && util5h >= util7d);
    chrome.action.setBadgeBackgroundColor({ color: showing5h ? '#06b6d4' : '#7c3aed' });
  }
}

// Error icon + badge on collection failure
export function updateBadgeError() {
  chrome.action.setBadgeText({ text: '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  chrome.action.setIcon({
    path: { 16: 'icons/icon16-error.png', 48: 'icons/icon48-error.png', 128: 'icons/icon128-error.png' },
  });
}

// Restore normal icon
export function resetIcon() {
  chrome.action.setIcon({
    path: { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
  });
}
