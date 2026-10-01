// ui/compare/attachments.js — the composer's attachments (#1617 images, #1944 documents), everything about them that
// is not DOM: what a file must be to be sent, how its bytes become the base64 the port carries,
// and which columns of a round can be asked with one.
//
// Separate from compare.js because all of it is pure (or takes its one effect as an argument), so
// the guard drives these directly instead of through a mounted page: the real File/Blob/FileReader
// do not exist in test/lib/mini-dom.mjs, and a "file" here is anything with `name`, `type`, `size`
// and `arrayBuffer()`.
//
// The wire shape is the SW's (bg/compare.js `normalizeSendAttachments`): `{name, type, data}` with
// `data` base64, at most ATTACH_MAX_FILES of them. `bytes` travels with it on the page only, to
// draw the chip.

import { ATTACH_MAX_BYTES, ATTACH_PROVIDERS, ATTACH_ERR_TYPE, ATTACH_ERR_SIZE, ATTACH_ERR_COUNT, ATTACH_ERR_TOTAL, SEND_KIND_SUMMARY, SEND_KIND_RETRY, SEND_VIA_COLUMN, SEND_VIA_DEBATE } from './constants.js';
import { attachTypeOf, providerTakesTypes } from './attach-types.js';

/**
 * base64 of these bytes, built in chunks.
 *
 * 🔴 NOT `btoa(String.fromCharCode(...u8))`: the spread makes one argument per byte, and at a few
 * hundred thousand of them V8 throws RangeError — a 10 MB image is 10.5 million. The bug is a
 * crash on the large files this feature exists for and silence on the small ones that fit, so the
 * chunk loop is the only form of this function (#1616, measured at 13 MB).
 */
export function bytesToBase64(u8) {
  const CHUNK = 0x8000; // 32 KiB of arguments per call — comfortably inside the limit on every engine we run on
  let s = '';
  for (let i = 0; i < u8.length; i += CHUNK) s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  return btoa(s);
}

/**
 * Why this file cannot be attached, or null when it can: ATTACH_ERR_TYPE (no provider takes its
 * type — attach-types.js) or ATTACH_ERR_SIZE.
 *
 * Type first, then size: a 40 MB video is refused for being a video, which is the thing about it
 * the user can act on — telling them to shrink it would be advice toward a file that would still
 * be refused. `size` 0 is a directory or an unreadable entry, not a file.
 */
export function attachmentError(file) {
  if (!attachTypeOf(file)) return ATTACH_ERR_TYPE;
  const size = file && Number.isFinite(file.size) ? file.size : 0;
  if (size <= 0 || size > ATTACH_MAX_BYTES) return ATTACH_ERR_SIZE;
  return null;
}

/**
 * The file as the wire wants it — `{name, type, bytes, data}` — or throws whatever reading it
 * threw. The caller checks `attachmentError` first; this does not repeat that check, so the one
 * place that decides what is attachable stays one place.
 */
export async function readAttachment(file) {
  const buf = await file.arrayBuffer();
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return {
    name: typeof file.name === 'string' && file.name.trim() ? file.name.trim() : 'file',
    // The type it TRAVELS as — an .md whose `File.type` was empty goes as text/markdown.
    type: attachTypeOf(file),
    bytes: u8.length,
    data: bytesToBase64(u8),
  };
}

/**
 * Can a round carrying files of `types` be sent to this provider? (PROVIDER_SITES.uploads plus the
 * provider's own type set, page side — the SW asks the same of the same module.) #1944: a site can
 * take the images of a round and not its PDF, so the answer depends on what is in the tray.
 */
export function providerTakesFiles(provider, types) {
  return ATTACH_PROVIDERS.includes(provider) && providerTakesTypes(provider, types);
}

/**
 * The providers among `colIds` that CANNOT take this round's files, in page order and without
 * repeats — the columns the SW will refuse with `unsupported` if this round goes out with them.
 *
 * Providers rather than columns on purpose: two Gemini columns are one sentence to write
 * (「Gemini」), and it is the SITE that does not take the file, not the model.
 * @param {string[]} colIds
 * @param {(id: string) => ({provider?: string} | undefined)} columnOf
 * @param {string[]} types — the tray's file types
 */
export function unsupportedProviders(colIds, columnOf, types) {
  const out = [];
  for (const id of colIds) {
    const provider = (columnOf(id) || {}).provider;
    if (!provider || providerTakesFiles(provider, types) || out.includes(provider)) continue;
    out.push(provider);
  }
  return out;
}

/** The targets left once the columns that cannot take this round's files are dropped. */
export function targetsTakingFiles(colIds, columnOf, types) {
  return colIds.filter((id) => providerTakesFiles((columnOf(id) || {}).provider, types));
}

/**
 * The first attachable image among a drop's / a paste's items, or `{file: null, error}` when there
 * were files but none of them could be attached.
 *
 * 🔴 A refusal is only reported when the transfer held FILES. A plain text drag (a selection, a
 * link) and a text paste carry `files: []` and must fall through to the textarea's own handling —
 * reporting "not an image" for a pasted sentence would be a broken composer, not a guard. Copying
 * an image in another page yields both an `image/png` file and an HTML fallback; taking the file
 * is what the user meant.
 */
/**
 * Every attachable file in a drop / paste, plus the first refusal among the rest (#1634).
 *
 * 🔴 A refusal is only reported when the transfer held FILES at all. A plain text drag and a text
 * paste carry `files: []` and must fall through to the textarea's own handling — reporting "not an
 * image" for a pasted sentence would be a broken composer, not a guard.
 *
 * @returns {{usable: File[], error: string|null}}
 */
export function pickAttachableAll(files) {
  const list = Array.from(files || []);
  if (!list.length) return { usable: [], error: null };
  const usable = [];
  let firstError = null;
  for (const f of list) {
    const err = attachmentError(f);
    if (!err) usable.push(f);
    else if (!firstError) firstError = err;
  }
  return { usable, error: firstError };
}

export function pickAttachable(files) {
  const list = Array.from(files || []);
  if (!list.length) return { file: null, error: null };
  let firstError = null;
  for (const f of list) {
    const err = attachmentError(f);
    if (!err) return { file: f, error: null };
    if (!firstError) firstError = err;
  }
  return { file: null, error: firstError };
}

/**
 * Which of `files` (already attachable, in the order chosen) get a slot in a tray holding
 * `items` — decided from `File.size` BEFORE anything is read (#1647). Reading first and summing
 * after meant five 10 MiB drops were all read and base64-encoded (~67 MB of string) only for four
 * to be refused.
 *
 * 🔴 ONE QUESTION EACH, so the two checks never answer the same thing twice (#1634's lesson):
 * this is 「is there ROOM」 — a slot still reading holds its `size` (what `File.size` promised),
 * a filled one its `bytes`; `attachFile`'s check after the read is 「what was it REALLY」, for a
 * file whose bytes turned out larger than its size said.
 *
 * A file that does not fit the total is skipped, not the end of the batch: a smaller one after it
 * may still fit. `error` is the reason to show — the count, when files were left over for want of
 * a slot, else the total when any was skipped for size, else null.
 * @returns {{take: File[], error: string|null}}
 */
export function reserveAttachments(items, files, maxFiles, maxTotal) {
  const room = maxFiles - items.length;
  let held = items.reduce((n, a) => n + (a.reading ? (Number.isFinite(a.size) ? a.size : 0) : a.bytes), 0);
  const take = [];
  let overCount = false;
  let overTotal = false;
  for (const f of files) {
    if (take.length >= room) { overCount = true; break; }
    if (held + f.size > maxTotal) { overTotal = true; continue; }
    held += f.size;
    take.push(f);
  }
  return { take, error: overCount ? ATTACH_ERR_COUNT : overTotal ? ATTACH_ERR_TOTAL : null };
}

/** `13.1 MB` / `842 KB` — the chip's size, in the units the limit is quoted in. */
export function formatBytes(bytes) {
  const KB = 1024;
  const MB = KB * 1024;
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / KB))} KB`;
}

/**
 * The attachment THIS round carries, or null.
 *
 * 🔴 The file goes with the box it sits above, and with nothing else. A summary and a column's own
 * follow-up are rounds the user did not choose a file for: the tray is the dock's, and the chip is
 * still showing because it is waiting for the dock's next question. Putting it on one of them
 * re-uploads the same image and charges a compare for it.
 *
 * 🔴 A RETRY carries nothing either, and `retryNeedsAttachment()` below is why that is safe —
 * see the note in the body for the design that was tried first and what it cost.
 *
 * One function because TWO places ask: the turns are drawn before the wire message is built, and
 * a marker on a round that sent no file is a lie while a round that sent one with no marker loses
 * it from the history for good.
 *
 * @returns {Array<{name, type, data, bytes}>} — empty when this round carries none
 */
/**
 * Is this round the DOCK COMPOSER's own? (Not a summary, not a retry, not a column's own box.)
 *
 * 🔴 THE TRAY BELONGS TO A ROUND, NOT TO THE FILES — three review rounds asked「when does the
 * refusal notice end」and the first two answers were both about the FILES: first「a successful
 * read must not clear it」(right, but left no end at all), then「the round that CARRIED files
 * clears it」(which never fires when every read failed, so the notice outlived an empty tray
 * again). The notice is about the user's last attach ATTEMPT at this composer, and what ends an
 * attempt is the user moving on — sending from that composer, whether or not anything rode along.
 *
 * A summary, a retry and a column's own follow-up are not that composer's rounds, so they end
 * nothing: clearing on every CONSUME_OK would let them wipe a notice they know nothing about.
 */
export function roundOwnsTray(sendKind, via) {
  return sendKind !== SEND_KIND_SUMMARY && sendKind !== SEND_KIND_RETRY && via !== SEND_VIA_COLUMN && via !== SEND_VIA_DEBATE;
}

export function attachmentsForRound(state, sendKind, via) {
  const ready = state.attachItems.filter((a) => !a.reading);
  if (!ready.length) return [];
  // 🔴 A RETRY NEVER CARRIES ONE — and this is the SECOND design here, which is the part worth
  // reading. The first kept the sent file alive so a retry could re-send it, and a verification
  // round found three defects in that one idea: another conversation's image rode a retry after a
  // history load (the kept file outlived the session), an image retry wiped the file the composer
  // was holding for the NEXT question, and a reload lost the markers the whole thing was keyed on.
  // All three came from ONE thing: state that outlives the round it belongs to.
  //
  // So the round no longer owns anything after it ends. A retry of a round that had an image is
  // REFUSED instead (`retryNeedsAttachment`), which the user resolves by attaching it again — a
  // worse click, and an invariant small enough to be right.
  if (sendKind === SEND_KIND_SUMMARY || sendKind === SEND_KIND_RETRY) return [];
  // Outside those, the file rides only the DOCK's composer. A column's own follow-up is a round
  // the user did not choose it for — nor is a round the debate orchestrator composed (#1769).
  return via === SEND_VIA_COLUMN || via === SEND_VIA_DEBATE ? [] : ready;
}

/**
 * A retry of a round that went out WITH an image must not go out without one.
 *
 * Re-asking the question alone is a different question, and the server charges for it — the
 * original defect this whole area exists to close (1.33.0 batch review). `roundHadImage` is read
 * from the markers the turns keep, so it survives a reload; the column says why and spends
 * nothing (`retry_needs_image`).
 */
export function retryNeedsAttachment(roundHadImage) {
  return !!roundHadImage;
}
