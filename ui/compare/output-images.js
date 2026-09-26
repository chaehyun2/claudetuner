// ui/compare/output-images.js — images IN THE ANSWER (#1684): a picture ChatGPT / Gemini generated
// or edited, shown in that provider's column.
//
// The SW hands each one over as IMAGE{mime, data (base64), width, height, alt} — or IMAGE{error}
// when the provider made one that could not be carried — always before the column's DONE
// (bg/compare.js imageForPage). This slice turns them into the turn's `outImages`:
//
//   items   [{ id } | { failed: true }], in arrival order, at most MAX_OUTPUT_IMAGES. `id` is minted
//           HERE (never the client's `img-N`, never a provider id) and names the image in the SAME
//           store the question's images use (image-store.js): a preview for the page, persisted
//           only with the history write — so an incognito round never reaches the disk.
//   strip   the DOM under the answer, built once per image and cached on the turn: paintAssistant
//           clears the turn node on every chunk and re-appends the SAME strip, so a loaded <img>
//           is moved, never reloaded (no flicker while the text still streams).
//
// 🔴 Nothing here parses markup. The bytes become a Blob (the browser's image decoder is the only
// thing that reads them), `alt` is an attribute value, the provider label is text. md-render keeps
// its image rule off — model markdown still cannot put an <img> on the page; only this slice can,
// and only for bytes that crossed the SW's validation.

import { OUTPUT_IMAGE_MIMES, MAX_OUTPUT_IMAGES } from '../../vendor-ai/output-image.js';
import { isImageId } from './image-store.js';
import { PROVIDER_META, OUT_IMAGE_ORIGINALS_MAX_BYTES, OUT_IMAGE_EXT, IMAGE_PREVIEW_TYPE } from './constants.js';

// The only kind of URL the download link may carry (the compare-xss guard pins it).
const OBJECT_URL_PREFIX = 'blob:';

/** base64 → Blob of `mime`, or null when it is not base64 (atob throws) or not an allowed type. */
export function base64ToBlob(data, mime, { atob: decode = globalThis.atob, Blob: B = globalThis.Blob } = {}) {
  if (typeof data !== 'string' || !data || !OUTPUT_IMAGE_MIMES.includes(mime) || typeof decode !== 'function' || typeof B !== 'function') return null;
  try {
    const bin = decode(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new B([bytes], { type: mime });
  } catch {
    return null;
  }
}

/**
 * A turn's `outImages` as the history keeps it: `{ ids }` — one SLOT per image in arrival order, the
 * image's id or `null` for one that could not be carried. Never a picture. 🔴 Slots, not "ids + a
 * failed count" (Codex host batch R1): a count loses where the failures were, and `[failed, image]`
 * came back as `[image, failed]`.
 */
export function outImagesMarker(outImages) {
  const items = outImages && Array.isArray(outImages.items) ? outImages.items.slice(0, MAX_OUTPUT_IMAGES) : [];
  const ids = [];
  for (const i of items) {
    if (i && isImageId(i.id)) ids.push(i.id);
    else if (i && i.failed === true) ids.push(null);
  }
  return ids.length ? { ids } : null;
}

/**
 * A stored marker read back (history normalizeEntry): the marker, or `undefined` when it is not
 * one — which, like every typed field there, drops the whole entry (not an object, `ids` not an
 * array, more slots than MAX_OUTPUT_IMAGES). A slot that is neither null nor a valid id is only
 * dropped (a bad id costs a thumbnail, never the entry), like the question's.
 */
export function readOutImagesMarker(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v) || !Array.isArray(v.ids) || v.ids.length > MAX_OUTPUT_IMAGES) return undefined;
  const ids = v.ids.filter((x) => x === null || isImageId(x));
  return { ids };
}

/**
 * How many images a turn's answer carried — a live turn (`outImages`) or a stored one (the history
 * marker `images: {ids}`, failed slots included). The one count every "is this an answer" check
 * uses (#1684).
 */
export function outImageCountOf(turn) {
  if (!turn) return 0;
  if (turn.outImages && Array.isArray(turn.outImages.items)) return turn.outImages.items.length;
  const m = turn.images;
  return m && typeof m === 'object' && Array.isArray(m.ids) ? m.ids.length : 0;
}

/** Installs the output-images slice onto `ctx` (see ui/compare/history.js for the ctx contract). */
export function installOutputImages(ctx) {
  const { doc, el, t, imageStore } = ctx;
  const urls = globalThis.URL;
  // id → { url, bytes } — the provider's original bytes, for 「저장」, for this page only (never
  // persisted). Insertion order = age: the oldest go first once the total passes the cap.
  const originals = new Map();
  let originalBytes = 0;
  // id → its 「저장」 button, so an original dropped for the cap relabels it (Codex B 1R follow-up).
  const saveButtons = new Map();
  const labelSave = (btn, live) => {
    btn.textContent = t(live ? 'out_image_download' : 'out_image_download_preview');
    btn.title = t(live ? 'out_image_download_title' : 'out_image_download_preview_title');
  };
  function keepOriginal(id, blob) {
    if (!blob || typeof urls?.createObjectURL !== 'function' || blob.size > OUT_IMAGE_ORIGINALS_MAX_BYTES) return;
    let url;
    try { url = urls.createObjectURL(blob); } catch { return; }
    originals.set(id, { url, bytes: blob.size });
    originalBytes += blob.size;
    for (const [old, o] of originals) {
      if (originalBytes <= OUT_IMAGE_ORIGINALS_MAX_BYTES) break;
      originals.delete(old);
      originalBytes -= o.bytes;
      // Safe to revoke: nothing holds it — the <img> shows the preview, the download link resolves
      // its URL at click time.
      try { urls.revokeObjectURL(o.url); } catch { /* already gone */ }
      if (saveButtons.has(old)) labelSave(saveButtons.get(old), false);
    }
  }
  const mintId = () => {
    try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch { /* no crypto */ }
    return `o-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  };

  /**
   * One IMAGE message onto the live turn. false when the turn already holds MAX_OUTPUT_IMAGES (the
   * SW caps them too; this is the page's own bound). A message whose bytes do not decode is a
   * failed slot, like the SW's error placeholder: the provider did answer with a picture.
   */
  function addOutputImage(col, turn, msg) {
    if (!turn.outImages) turn.outImages = { items: [] };
    const items = turn.outImages.items;
    if (items.length >= MAX_OUTPUT_IMAGES) return false;
    const blob = msg && typeof msg.error !== 'string' ? base64ToBlob(msg.data, msg.mime) : null;
    if (!blob) { items.push({ failed: true }); return true; }
    const id = mintId();
    imageStore.add(id, blob);
    keepOriginal(id, blob);
    items.push({ id, mime: msg.mime, alt: typeof msg.alt === 'string' ? msg.alt : '' });
    return true;
  }
  /** A stored marker onto a restored turn (history). */
  function restoreOutputImages(turn, marker) {
    if (!marker) return;
    turn.outImages = { items: marker.ids.map((id) => (id ? { id } : { failed: true })) };
  }
  const outImageIds = (turn) => (turn && turn.outImages ? turn.outImages.items.filter((i) => i.id).map((i) => i.id) : []);
  const outImageCount = outImageCountOf;

  /** Hand the picture over: the original while this page holds it, else the stored preview. */
  async function downloadImage(col, id, n) {
    const orig = originals.get(id);
    const url = orig ? orig.url : await imageStore.url(id);
    // Only an object URL this page made from the bytes — never anything a provider could name.
    if (typeof url !== 'string' || !url.startsWith(OBJECT_URL_PREFIX)) return;
    const item = outImageItem(id) || {};
    const ext = orig ? (OUT_IMAGE_EXT[item.mime] || 'png') : OUT_IMAGE_EXT[IMAGE_PREVIEW_TYPE];
    const a = doc.createElement('a');
    a.setAttribute('href', url);
    a.setAttribute('download', `${col.provider}-image-${n}${orig ? '' : '-preview'}.${ext}`);
    a.hidden = true;
    doc.body.appendChild(a);
    try { a.click(); } finally { a.remove(); }
  }
  // id → item, across the columns' turns (for the download's extension).
  function outImageItem(id) {
    for (const c of ctx.state.columns.values()) for (const turn of c.turns) if (turn.outImages) for (const i of turn.outImages.items) if (i.id === id) return i;
    return null;
  }

  function imageSlot(col, turn, item, n) {
    if (item.failed) return el('p', 'cmp-out-img-failed', t('out_image_failed', PROVIDER_META[col.provider].label));
    const fig = el('div', 'cmp-out-img');
    const b = el('button', 'cmp-out-img-btn');
    b.type = 'button';
    b.title = t('out_image_view');
    b.setAttribute('aria-label', t('out_image_view_n', n));
    const pic = el('img', 'cmp-out-img-pic');
    pic.setAttribute('alt', item.alt || '');
    pic.hidden = true;
    b.appendChild(pic);
    // The viewer steps through this turn's images (their ids at click time — a later one may have landed).
    b.addEventListener('click', () => { const ids = outImageIds(turn); ctx.openImageViewer(ids, Math.max(0, ids.indexOf(item.id)), b); });
    fig.appendChild(b);
    const dl = el('button', 'cmp-out-img-dl');
    dl.type = 'button';
    labelSave(dl, originals.has(item.id));
    saveButtons.set(item.id, dl);
    dl.addEventListener('click', () => { downloadImage(col, item.id, n); });
    fig.appendChild(dl);
    imageStore.url(item.id).then((u) => {
      if (u) { pic.src = u; pic.hidden = false; return; }
      b.classList.add('is-gone');
      b.title = t('attach_gone');
      dl.hidden = !originals.has(item.id);
    });
    return fig;
  }
  /** The turn's strip, with a slot for every image that has arrived — cached, so a repaint re-appends the same nodes. */
  function outImageStrip(col, turn) {
    if (!turn.outStrip) { turn.outStrip = el('div', 'cmp-out-imgs'); turn.outStripN = 0; }
    const items = turn.outImages ? turn.outImages.items : [];
    while (turn.outStripN < items.length) {
      turn.outStrip.appendChild(imageSlot(col, turn, items[turn.outStripN], turn.outStripN + 1));
      turn.outStripN += 1;
    }
    return turn.outStrip;
  }

  Object.assign(ctx, { addOutputImage, restoreOutputImages, outImageIds, outImageCount, outImageStrip });
}
