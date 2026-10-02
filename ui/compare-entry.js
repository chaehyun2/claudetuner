// The popup's feature row under the gauges (#compare-entry): which of the two banners it shows.
//
// Two banners share the one row — 「AI 크로스체크」 and 「AI끼리 토론시키기」 — and take turns by
// TIME, not by animation: the row holds one banner for COMPARE_ENTRY_ROTATE_MS, then the other.
// The variant is picked once when the popup/side panel opens and never swaps under the user; a
// side panel left open across a boundary shows the new banner on its next open.
//
// 🔑 Per-install offset (COMPARE_ENTRY_OFFSET_KEY, drawn once in [0, ROTATE)): without it every
// install would flip at the same wall-clock instant, so one banner would own whole hours of the day
// for everyone and its click rate would read as a time-of-day effect in GA. With it the two
// banners are spread evenly across hours, and the `popup` vs `popup_debate` placements compare.
//
// Pure picker + a storage-backed reader so a guard can execute both with a stub.

export const COMPARE_ENTRY_ROTATE_MS = 4 * 60 * 60 * 1000;
export const COMPARE_ENTRY_OFFSET_KEY = 'compareEntryOffsetMs';
export const ENTRY_CROSSCHECK = 'crosscheck';
export const ENTRY_DEBATE = 'debate';
export const ENTRY_VARIANTS = Object.freeze([ENTRY_CROSSCHECK, ENTRY_DEBATE]);
// The OPEN_COMPARE placement each banner sends (bg/compare.js COMPARE_SRCLESS_PLACEMENTS) — also
// the utm_content and the GA `placement`, so the two banners' clicks are told apart.
export const ENTRY_PLACEMENT = Object.freeze({ [ENTRY_CROSSCHECK]: 'popup', [ENTRY_DEBATE]: 'popup_debate' });

const validOffset = (v) => Number.isFinite(v) && v >= 0 && v < COMPARE_ENTRY_ROTATE_MS;

/** The banner for this instant and this install's offset. */
export function pickCompareEntry(nowMs, offsetMs) {
  const off = validOffset(offsetMs) ? offsetMs : 0;
  const slot = Math.floor((nowMs + off) / COMPARE_ENTRY_ROTATE_MS);
  return ENTRY_VARIANTS[((slot % ENTRY_VARIANTS.length) + ENTRY_VARIANTS.length) % ENTRY_VARIANTS.length];
}

/**
 * Read (or draw and save, on first use) this install's offset, then pick. A storage failure falls
 * back to offset 0 — the row still shows a banner; only the spread across installs is lost.
 */
export async function readCompareEntryVariant({ storage, now = Date.now, random = Math.random }) {
  let off = null;
  try {
    const got = await storage.get(COMPARE_ENTRY_OFFSET_KEY);
    off = got ? got[COMPARE_ENTRY_OFFSET_KEY] : null;
    if (!validOffset(off)) {
      off = Math.floor(random() * COMPARE_ENTRY_ROTATE_MS);
      await storage.set({ [COMPARE_ENTRY_OFFSET_KEY]: off });
    }
  } catch { off = 0; }
  return pickCompareEntry(now(), off);
}
