// ui/plan-auto-card.js — the popup card for an auto plan order (#2181 U4, plan §6.1 ②).
// A scheduled auto downgrade stays visible until it applies; an applied upgrade shows for a day. Both offer
// [원치 않아요] (#2435): a preset reason, an optional note and a 7/14-day pause go to the server, then a
// scheduled downgrade is cancelled on its own site (bg REFUSE_AUTO_ORDER). There is no [accept] — an auto
// order runs only through bg/plan-auto.js. Text goes in via textContent (plan names come from the server).
import { PLAN_AUTO_CARD_READ_KEYS, pickPlanAutoCards, AUTO_OUTCOME, planChangeUrl, PA_REFUSE_REASONS } from '../bg/plan-auto.js';
import { buildRefuseForm } from './refuse-form.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A scheduled downgrade without a known change date is shown for one monthly cycle at most. */
const DOWN_FALLBACK_MS = 31 * DAY_MS;
/** A refused card stays as long as the longest pause a member can pick (PA_PAUSE_DAYS). */
const REFUSED_SHOW_MS = 14 * DAY_MS;

/** "10/24" style date of a server UTC datetime ('YYYY-MM-DD HH:MM:SS'), or '—'. */
const pauseDate = (s) => {
  const ms = Date.parse(String(s || '').replace(' ', 'T') + 'Z');
  return Number.isFinite(ms) ? new Date(ms).toLocaleDateString() : '—';
};

/** Pure: what the card shows for `card` at `now`, or null for nothing. `t` = the popup translator. */
export function planAutoCardView(card, now, t) {
  if (!card || !card.order_id) return null;
  const age = now - (card.at || 0);
  // #2435: the member said no — say what happens now (the pause), no more buttons.
  if (card.refused) {
    if (age > REFUSED_SHOW_MS) return null;
    return { text: t('pa_card_refused', pauseDate(card.refused.pause_until)), cancel: false, refuse: false, why: true, tone: 'info' };
  }
  const scheduledDown = card.result === 'completed' && !card.outcome && !card.is_up && card.kind !== 'cancel_downgrade';
  if (scheduledDown) {
    const until = card.change_date ? Date.parse(card.change_date) : (card.at || 0) + DOWN_FALLBACK_MS;
    if (!(now < (Number.isFinite(until) ? until : (card.at || 0) + DOWN_FALLBACK_MS))) return null;
    const date = card.change_date ? new Date(card.change_date).toLocaleDateString() : '—';
    // #2435: [원치 않아요] for both services — the reason and a short pause go to the server first, then the
    // reservation is cancelled (a bare cancel would just be scheduled again by the next run, #2412).
    return { text: t('pa_card_down', card.from_plan, card.to_plan, date), cancel: false, refuse: true, refuseUp: false, why: true, tone: 'ok' };
  }
  if (age > DAY_MS) return null;
  if (card.result === 'reverted') return { text: t('pa_card_reverted'), cancel: false, why: true, tone: 'info' };
  if (card.result === 'revert_pending') return { text: t('pa_card_revert_pending'), cancel: false, why: true, tone: 'info' };
  if (card.result === 'completed' && !card.outcome) {
    return card.kind === 'cancel_downgrade'
      ? { text: t('pa_card_cancel_down'), cancel: false, why: true, tone: 'info' }
      : { text: t('pa_card_up', card.from_plan, card.to_plan), cancel: false, refuse: !!card.is_up, refuseUp: true, why: true, tone: 'ok' };
  }
  if (card.result === 'failed' && card.outcome === AUTO_OUTCOME.apiError) {
    return { text: t('pa_card_fail', card.from_plan, card.to_plan), cancel: false, why: true, tone: 'warn' };
  }
  if (card.result === 'unknown') return { text: t('pa_card_unknown', card.from_plan, card.to_plan), cancel: false, why: true, tone: 'warn' };
  return null;  // a charge-free premise skip is not worth a card
}

/** Service names on the card — product names, not translated. */
const SERVICE_LABEL = Object.freeze({ claude: 'Claude', chatgpt: 'ChatGPT' });

let _watching = false;
/**
 * Re-render whenever a card is written (an order scheduled or settled while the popup / side panel stays open) —
 * the generic [다운그레이드 취소] is hidden for OUR reservation (ui/render.js), so a stale card would leave the
 * member with no way to refuse it. Not while a refusal form is open: re-rendering would throw away what the
 * member is typing; closing the form renders the latest state.
 */
export function watchPlanAutoCards(t) {
  if (_watching) return;
  _watching = true;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !PLAN_AUTO_CARD_READ_KEYS.some((k) => k in changes)) return;
    renderPlanAutoCard(t);   // skips by itself while a refusal form is open (checked when it renders)
  });
}

/** One card per service (#2358), Claude first. Reads the legacy single card too (pickPlanAutoCards).
 *  Leaves the cards alone while a refusal form is open — checked when the read COMES BACK, not when it starts,
 *  so a form opened during the read is not thrown away. `force`: the form's own submit / close. */
export function renderPlanAutoCard(t, { force = false } = {}) {
  chrome.storage.local.get(PLAN_AUTO_CARD_READ_KEYS, (store) => {
    const box = document.getElementById('plan-auto-cards');
    const tpl = document.getElementById('plan-auto-card-tpl');
    if (!box || !tpl) return;
    if (!force && document.querySelector('#plan-auto-cards .refuse-form')) return;
    box.replaceChildren();
    const cards = pickPlanAutoCards(store);
    for (const provider of Object.keys(SERVICE_LABEL)) {
      const card = cards[provider];
      const view = planAutoCardView(card, Date.now(), t);
      if (!view) continue;
      const el = tpl.content.firstElementChild.cloneNode(true);
      el.dataset.tone = view.tone;
      el.dataset.provider = provider;
      el.querySelector('.pa-card-svc').textContent = SERVICE_LABEL[provider];
      el.querySelector('.pa-card-text').textContent = view.text;
      const why = el.querySelector('.pa-card-why');
      why.textContent = t('pa_card_why');
      why.href = planChangeUrl(card.org_id, card.order_id);
      why.classList.toggle('hidden', !view.why || card.org_id == null);
      const btn = el.querySelector('.pa-card-cancel');
      btn.textContent = t('pa_card_cancel_btn');
      btn.classList.toggle('hidden', !view.cancel);
      btn.onclick = () => {
        btn.disabled = true;
        chrome.runtime.sendMessage({ type: 'CANCEL_AUTO_DOWNGRADE', orderId: card.order_id }, (res) => {
          btn.disabled = false;
          if (res?.success) renderPlanAutoCard(t);
        });
      };
      const refuse = el.querySelector('.pa-card-refuse');
      const formBox = el.querySelector('.pa-card-form');
      // An older cached popup.html template has no refusal parts — the card still renders without them.
      if (refuse && formBox) wireRefuse(refuse, formBox, view, card, provider, t);
      box.appendChild(el);
    }
  });
}

/** [원치 않아요] → the reason form → bg REFUSE_AUTO_ORDER (#2435). */
function wireRefuse(refuse, formBox, view, card, provider, t) {
      refuse.textContent = t('pa_card_refuse_btn');
      refuse.classList.toggle('hidden', !view.refuse);
      refuse.onclick = () => {
        refuse.classList.add('hidden');
        formBox.replaceChildren(buildRefuseForm(t, {
          reasons: view.refuseUp ? PA_REFUSE_REASONS.up : PA_REFUSE_REASONS.down,
          withPause: true,
          hint: view.refuseUp ? t('pa_refuse_up_hint') : null,
          // Closing catches up with any card change skipped while the form was open (watchPlanAutoCards).
          onCancel: () => { formBox.replaceChildren(); refuse.classList.remove('hidden'); renderPlanAutoCard(t, { force: true }); },
          onSubmit: (v) => new Promise((resolve) => {
            chrome.runtime.sendMessage({ type: 'REFUSE_AUTO_ORDER', orderId: card.order_id, reason: v.reason, note: v.note, pauseDays: v.pauseDays }, (res) => {
              if (chrome.runtime.lastError || !res?.success) { resolve(t('pa_refuse_failed')); return; }
              // Recorded; a failed cancel of the reservation is the member's to finish on the site.
              if (res.cancel_failed) alert(t('pa_refuse_cancel_failed', SERVICE_LABEL[provider]));
              resolve(null);
              renderPlanAutoCard(t, { force: true });
            });
          }),
        }));
      };
}
