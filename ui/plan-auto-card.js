// ui/plan-auto-card.js — the popup card for an auto plan order (#2181 U4, plan §6.1 ②).
// A scheduled auto downgrade stays visible until it applies, with [예약 취소] (bg CANCEL_AUTO_DOWNGRADE);
// everything else shows for a day. There is no [accept] — an auto order runs only through
// bg/plan-auto.js. Text goes in via textContent (plan names come from the server).
import { PLAN_AUTO_CARD_KEY, AUTO_OUTCOME, planChangeUrl } from '../bg/plan-auto.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A scheduled downgrade without a known change date is shown for one monthly cycle at most. */
const DOWN_FALLBACK_MS = 31 * DAY_MS;

/** Pure: what the card shows for `card` at `now`, or null for nothing. `t` = the popup translator. */
export function planAutoCardView(card, now, t) {
  if (!card || !card.order_id) return null;
  const age = now - (card.at || 0);
  const scheduledDown = card.result === 'completed' && !card.outcome && !card.is_up && card.kind !== 'cancel_downgrade';
  if (scheduledDown) {
    const until = card.change_date ? Date.parse(card.change_date) : (card.at || 0) + DOWN_FALLBACK_MS;
    if (!(now < (Number.isFinite(until) ? until : (card.at || 0) + DOWN_FALLBACK_MS))) return null;
    const date = card.change_date ? new Date(card.change_date).toLocaleDateString() : '—';
    return { text: t('pa_card_down', card.from_plan, card.to_plan, date), cancel: true, why: true, tone: 'ok' };
  }
  if (age > DAY_MS) return null;
  if (card.result === 'reverted') return { text: t('pa_card_reverted'), cancel: false, why: true, tone: 'info' };
  if (card.result === 'revert_pending') return { text: t('pa_card_revert_pending'), cancel: false, why: true, tone: 'info' };
  if (card.result === 'completed' && !card.outcome) {
    return card.kind === 'cancel_downgrade'
      ? { text: t('pa_card_cancel_down'), cancel: false, why: true, tone: 'info' }
      : { text: t('pa_card_up', card.from_plan, card.to_plan), cancel: false, why: true, tone: 'ok' };
  }
  if (card.result === 'failed' && card.outcome === AUTO_OUTCOME.apiError) {
    return { text: t('pa_card_fail', card.from_plan, card.to_plan), cancel: false, why: true, tone: 'warn' };
  }
  if (card.result === 'unknown') return { text: t('pa_card_unknown', card.from_plan, card.to_plan), cancel: false, why: true, tone: 'warn' };
  return null;  // a charge-free premise skip is not worth a card
}

export function renderPlanAutoCard(t) {
  chrome.storage.local.get({ [PLAN_AUTO_CARD_KEY]: null }, (store) => {
    const card = store[PLAN_AUTO_CARD_KEY];
    const el = document.getElementById('plan-auto-card');
    if (!el) return;
    const view = planAutoCardView(card, Date.now(), t);
    if (!view) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.dataset.tone = view.tone;
    document.getElementById('plan-auto-card-text').textContent = view.text;
    const why = document.getElementById('plan-auto-card-why');
    why.textContent = t('pa_card_why');
    why.href = planChangeUrl(card.org_id, card.order_id);
    why.classList.toggle('hidden', !view.why || card.org_id == null);
    const btn = document.getElementById('plan-auto-card-cancel');
    btn.textContent = t('pa_card_cancel_btn');
    btn.classList.toggle('hidden', !view.cancel);
    btn.onclick = () => {
      btn.disabled = true;
      chrome.runtime.sendMessage({ type: 'CANCEL_AUTO_DOWNGRADE', orderId: card.order_id }, (res) => {
        btn.disabled = false;
        if (res?.success) renderPlanAutoCard(t);
      });
    };
  });
}
