// ui/compare/attach-types.js — which file types a round may carry, and which provider takes which
// (#1944: documents beside images). Imported by BOTH the compare page and the SW (bg/compare.js),
// so the page's refusal and the SW's validation read one answer.
//
// 🔴 NOT A LIST OF OUR OWN. The per-provider sets are the vendored clients' `ATTACHMENT_TYPES`
// statics (vendor-ai `attachmentTypesFor`), measured live on each site by the package — a type is
// in a client's set only once its upload path was verified there. Spelling a copy here is how the
// tray would come to accept a PDF the package then refuses AFTER the round was debited.

import { PROVIDERS, attachmentTypesFor } from '../../vendor-ai/index.js';
import { MIME_BY_EXTENSION, isImageInputType } from '../../vendor-ai/mime.js';
import { ATTACH_KINDS, ATTACH_KIND_IMAGE, ATTACH_KIND_FILE } from './constants.js';

const TYPES_BY_PROVIDER = Object.freeze(Object.fromEntries(PROVIDERS.map((p) => [p, attachmentTypesFor(p)])));

/** Every type at least one provider takes — what the tray accepts at all. Images first, in the package's order. */
export const ATTACH_TYPES = Object.freeze([...new Set(PROVIDERS.flatMap((p) => TYPES_BY_PROVIDER[p]))]);

/** The types `provider` takes; [] for one the package does not know. */
export function attachTypesOf(provider) {
  return Object.prototype.hasOwnProperty.call(TYPES_BY_PROVIDER, provider) ? TYPES_BY_PROVIDER[provider] : [];
}

/** Can `provider` be asked with a round carrying every one of `types`? (An empty list: yes.) */
export function providerTakesTypes(provider, types) {
  const own = attachTypesOf(provider);
  return (types || []).every((t) => own.includes(t));
}

export function isImageType(type) {
  return isImageInputType(type);
}

/**
 * The marker KIND of a file that travels as `type` (ATTACH_KINDS): 'image' for any picture, else
 * the extension the type is spelled with (`markdown` reads as `md`), else 'file'.
 */
export function attachKindOf(type) {
  if (isImageInputType(type)) return ATTACH_KIND_IMAGE;
  const ext = Object.keys(MIME_BY_EXTENSION).find((e) => MIME_BY_EXTENSION[e] === type);
  return ext && ATTACH_KINDS.includes(ext) ? ext : ATTACH_KIND_FILE;
}

/** Extensions per accepted type, `.png` style — the picker's `accept` names both, see ATTACH_ACCEPT. */
const EXTENSIONS = Object.entries(MIME_BY_EXTENSION).filter(([, type]) => ATTACH_TYPES.includes(type)).map(([ext]) => ext);

/**
 * The picker's `accept`: the MIME types AND the extensions. A hint to the OS dialog, never the
 * check — but a dialog filtering on `text/markdown` alone greys out every .md on an OS that has
 * no MIME type for it, which is most of them.
 */
export const ATTACH_ACCEPT = [...ATTACH_TYPES, ...EXTENSIONS.map((e) => `.${e}`)].join(',');

/** 「PNG · JPG · … · CSV」 — the formats for the limit line and the refusal, one label per type. */
export const ATTACH_FORMATS_LABEL = ATTACH_TYPES
  .map((type) => Object.keys(MIME_BY_EXTENSION).find((ext) => MIME_BY_EXTENSION[ext] === type))
  .filter(Boolean)
  .map((ext) => ext.toUpperCase())
  .join(' · ');

/**
 * The MIME type a file will travel as, or '' when it is none the tray accepts. The page (tray)
 * and the SW (`normalizeSendAttachments`) both decide with THIS function.
 *
 * 🔴 A KNOWN EXTENSION WINS over `File.type` (Codex #1944 1R blocker). The declared type is
 * whatever the OS or the dragging app said: a `report.pdf` dropped with `type: 'image/png'` was
 * taken as a PNG — into the image store, debited, then sent to chatgpt.com as an image whose
 * pixel size could not be read. The name is what the user sees and chose, and a browser leaves
 * `File.type` empty for .md (and .csv) on several OSes, says `text/x-markdown` on others, and
 * Windows calls a .csv `application/vnd.ms-excel`. So: an extension in MIME_BY_EXTENSION decides
 * (and a known extension no provider takes is refused, whatever the type claims); only a name
 * with no extension, or one we do not know, falls back to the declared type.
 */
export function attachTypeOf(file) {
  const name = file && typeof file.name === 'string' ? file.name.trim().toLowerCase() : '';
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1) : '';
  if (ext && Object.prototype.hasOwnProperty.call(MIME_BY_EXTENSION, ext)) {
    const byExt = MIME_BY_EXTENSION[ext];
    return ATTACH_TYPES.includes(byExt) ? byExt : '';
  }
  const declared = file && typeof file.type === 'string' ? file.type.trim().toLowerCase() : '';
  return ATTACH_TYPES.includes(declared) ? declared : '';
}

