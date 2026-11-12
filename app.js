/* Typo — minimal local-first font browser.
 * No build step, no dependencies. State lives in localStorage + IndexedDB,
 * and round-trips through a human-editable Markdown file. */
'use strict';

const CATS = ['Serif', 'Sans-Serif', 'Monospace', 'Display', 'Script/Handwriting', 'CJK'];
const LS_META = 'typo.meta.v1';
const LS_INFO = 'typo.info.v2';
const LS_UI = 'typo.ui.v1';
const LS_SET = 'typo.settings.v1';
const FONT_RE = /\.(ttf|otf|woff2?|ttc|otc)$/i;
const MONO_RE = /mono|code|courier|consol|terminal|fixed|typewriter/i;
const CJK_RE = /[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-䶿一-鿿가-힯]|\b(cjk|kr|jp|sc|tc|hk)\b|myeongjo|batang|gulim|dotum|gungsuh|nanum|malgun|mincho|meiryo|yu gothic|ms p?gothic|ms p?mincho|simsun|simhei|kaiti|fangsong|mingliu|yahei|jhenghei|dengxian|hiragino|source han|pretendard|spoqa/i;

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k != null) n.append(k);
  return n;
};
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const uniq = (a) => [...new Set(a.filter(Boolean))];
const junk = (s) => !s || !/[\p{L}\p{N}]/u.test(s);
const baseName = (n) => n.replace(/^.*[\\/]/, '').replace(FONT_RE, '');
localStorage.removeItem('typo.detect.v1');

/* ------------------------------------------------------------------ state */

/** family -> { title?, category?, tags: string[], hidden? }  (user metadata, keyed by real family name) */
let meta = load(LS_META, {});
/** family -> { cat, app: string[], alt: string[] }  (cached facts read from font tables) */
let info = load(LS_INFO, {});
/** family -> { family, styles: Style[], card? }
 *  Style: { family, style, full, ps, app, alt[], alias, fd?, files: [{ path, name, blob, folder?, dropped? }] } */
const fonts = new Map();
const psIndex = new Map();

const ui = Object.assign({
  text: 'The quick brown fox jumps over the lazy dog',
  size: 48, track: 0, view: 'grid', showHidden: false,
}, load(LS_UI, {}));
const settings = Object.assign({ systemOnStart: true, exportAll: true, watch: true }, load(LS_SET, {}));
const filter = { q: '', cats: new Set(), tags: new Set() };

let aliasSeq = 0;

function m(family) { return meta[family] || { tags: [] }; }
function clean(fam, x) {
  if (x.title != null) x.title = x.title.trim();
  if (!x.title || x.title === fam) delete x.title;
  if (!x.category) delete x.category;
  if (!x.hidden) delete x.hidden;
  x.tags ??= [];
  return x.tags.length || x.title || x.category || x.hidden ? x : null;
}
function setMeta(family, patch) {
  const x = clean(family, { tags: [], ...meta[family], ...patch });
  if (x) meta[family] = x; else delete meta[family];
  persistMeta();
}
const title = (f) => m(f.family).title || f.family;
function category(family) { return m(family).category || info[family]?.cat || guessByName(family); }

function persistMeta(write = true) {
  save(LS_META, meta);
  if (write) scheduleLinkedWrite();
}
let infoTimer;
function persistInfo() { clearTimeout(infoTimer); infoTimer = setTimeout(() => save(LS_INFO, info), 500); }

/* --------------------------------------------------------------- IndexedDB */

const idb = (() => {
  let dbp;
  const open = () => dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('typo', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('files'); r.result.createObjectStore('kv'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = async (store, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req?.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    get: (s, k) => tx(s, 'readonly', (o) => o.get(k)),
    put: (s, k, v) => tx(s, 'readwrite', (o) => o.put(v, k)),
    del: (s, k) => tx(s, 'readwrite', (o) => o.delete(k)),
    clear: (s) => tx(s, 'readwrite', (o) => o.clear()),
    all: async (s) => {
      const keys = await tx(s, 'readonly', (o) => o.getAllKeys());
      const vals = await tx(s, 'readonly', (o) => o.getAll());
      return keys.map((k, i) => [k, vals[i]]);
    },
  };
})();

/* ------------------------------------------------------- sfnt / woff parsing */

/** reader(offset, length) -> Promise<DataView>. Blob slices are lazy, so large files aren't read in full. */
const blobReader = (blob) => async (o, l) => new DataView(await blob.slice(o, o + l).arrayBuffer());
const tag4 = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));

async function inflate(dv) {
  const out = new Response(new Blob([dv]).stream().pipeThrough(new DecompressionStream('deflate')));
  return new DataView(await out.arrayBuffer());
}

/** Returns { get(tag) -> Promise<DataView|null> } or null for unsupported formats (woff2). */
async function openFont(read) {
  let head = await read(0, 12);
  let base = 0;
  const sig = tag4(head, 0);
  if (sig === 'wOFF') {
    const n = (await read(0, 44)).getUint16(12);
    const dir = await read(44, n * 20);
    const tables = {};
    for (let i = 0; i < n; i++) {
      const p = i * 20;
      tables[tag4(dir, p)] = { off: dir.getUint32(p + 4), comp: dir.getUint32(p + 8), orig: dir.getUint32(p + 12) };
    }
    return {
      async get(t) {
        const r = tables[t]; if (!r) return null;
        const dv = await read(r.off, r.comp);
        return r.comp < r.orig ? inflate(dv) : dv;
      },
    };
  }
  if (sig === 'wOF2') return null;
  if (sig === 'ttcf') { base = (await read(12, 4)).getUint32(0); head = await read(base, 12); }
  const n = head.getUint16(4);
  const dir = await read(base + 12, n * 16);
  const tables = {};
  for (let i = 0; i < n; i++) {
    const p = i * 16;
    tables[tag4(dir, p)] = { off: dir.getUint32(p + 8), len: dir.getUint32(p + 12) };
  }
  return { async get(t) { const r = tables[t]; return r ? read(r.off, r.len) : null; } };
}

/** Reads the name table.
 *  family = typographic family (ID 16, else 1), app = legacy family as Word/GIMP list it (ID 1),
 *  alt = family names in other languages (e.g. the Hangul name of a Korean font). */
async function readNames(font) {
  const dv = await font.get('name'); if (!dv) return {};
  const count = dv.getUint16(2), strOff = dv.getUint16(4);
  const recs = [];
  for (let i = 0; i < count; i++) {
    const p = 6 + i * 12;
    if (p + 12 > dv.byteLength) break;
    const plat = dv.getUint16(p), lang = dv.getUint16(p + 4), id = dv.getUint16(p + 6);
    const len = dv.getUint16(p + 8), start = strOff + dv.getUint16(p + 10);
    if (![1, 2, 4, 6, 16, 17].includes(id) || start + len > dv.byteLength) continue;
    let s = '';
    if (plat === 3 || plat === 0) for (let j = 0; j + 1 < len; j += 2) s += String.fromCharCode(dv.getUint16(start + j));
    else if (plat === 1 && lang === 0) for (let j = 0; j < len; j++) s += String.fromCharCode(dv.getUint8(start + j));
    else continue;
    s = s.replace(/\0/g, '').trim();
    if (s) recs.push({ plat, lang, id, s });
  }
  const en = (id) => (recs.find((r) => r.id === id && r.plat === 3 && r.lang === 0x409)
    || recs.find((r) => r.id === id && r.plat === 1)
    || recs.find((r) => r.id === id && r.plat === 0)
    || recs.find((r) => r.id === id))?.s;
  const family = en(16) || en(1), app = en(1);
  const alt = uniq(recs.filter((r) => (r.id === 1 || r.id === 16) && r.plat === 3 && r.lang !== 0x409).map((r) => r.s))
    .filter((s) => s !== family && s !== app);
  return { family, style: en(17) || en(2), full: en(4), ps: en(6), app, alt };
}

/** Classify from OS/2 code pages / Unicode ranges / family class / PANOSE + post.isFixedPitch. */
async function classifyTables(font, family) {
  if (MONO_RE.test(family)) return 'Monospace';
  const os2 = await font.get('OS/2');
  if (os2 && os2.byteLength >= 58) {
    const ur2 = os2.getUint32(46);                         // ulUnicodeRange2 (bits 32–63)
    const cp = os2.byteLength >= 86 ? os2.getUint32(78) : 0; // ulCodePageRange1
    // code pages 17–21: JIS, GB2312, Wansung, Big5, Johab; unicode bits 56 Hangul, 59 CJK ideographs
    if (((cp >>> 17) & 0x1f) || ((ur2 >>> 24) & 1) || ((ur2 >>> 27) & 1)) return 'CJK';
  }
  if (CJK_RE.test(family)) return 'CJK';
  const post = await font.get('post');
  if (post && post.byteLength >= 16 && post.getUint32(12) !== 0) return 'Monospace';
  if (!os2 || os2.byteLength < 42) return null;
  const cls = os2.getUint8(30);
  const pan = [0, 1, 2, 3].map((i) => os2.getUint8(32 + i));
  if (pan[0] === 2 && pan[3] === 9) return 'Monospace';
  if (pan[0] === 3 || cls === 10) return 'Script/Handwriting';
  if (pan[0] === 4 || pan[0] === 5 || cls === 9 || cls === 12) return 'Display';
  if (cls === 8) return 'Sans-Serif';
  if (cls >= 1 && cls <= 7) return 'Serif';
  if (pan[0] === 2) {
    if (pan[1] >= 11 && pan[1] <= 15) return 'Sans-Serif';
    if (pan[1] >= 2 && pan[1] <= 10) return 'Serif';
  }
  return null;
}

function guessByName(f) {
  if (MONO_RE.test(f)) return 'Monospace';
  if (CJK_RE.test(f)) return 'CJK';
  if (/script|hand|brush|callig|marker|comic|signature|ink free|segoe print|pen\b|chancery|kunstler|vivaldi|edwardian/i.test(f)) return 'Script/Handwriting';
  if (/display|poster|stencil|deco|impact|headline|black ?letter|fraktur|showcard|jokerman|chiller|symbol|dings|emoji|icons?\b|webdings|wingdings|marlett/i.test(f)) return 'Display';
  if (/sans|grotesk|grotesque|arial|helvetica|verdana|tahoma|segoe|inter\b|roboto|calibri|candara|corbel|futura|gill/i.test(f)) return 'Sans-Serif';
  if (/serif|roman|times|garamond|georgia|baskerville|bodoni|caslon|didot|antiqua|cambria|constantia|minion|palatino|book\b|century|bookman|sylfaen|old style/i.test(f)) return 'Serif';
  return 'Sans-Serif';
}

/** Everything we can learn from a font binary. Falls back to the file name for unreadable or junk names. */
async function inspect(blob, fallback) {
  const out = { family: fallback, style: 'Regular', full: fallback, ps: '', app: '', alt: [], cat: null };
  let font = null;
  try { font = await openFont(blobReader(blob)); } catch {}
  if (!font) return out;
  try {
    const n = await readNames(font);
    if (!junk(n.family)) out.family = n.family;
    out.style = n.style || out.style;
    out.full = n.full || `${out.family} ${out.style}`;
    out.ps = n.ps || '';
    out.app = n.app || '';
    out.alt = n.alt || [];
  } catch {}
  try { out.cat = await classifyTables(font, out.family); } catch {}
  return out;
}

/* -------------------------------------------------------------- font sources */

function addStyle(family, s) {
  if (s.ps && psIndex.has(s.ps)) {            // same face from another source: merge, don't duplicate
    const ex = psIndex.get(s.ps);
    if (s.fd && !ex.fd) ex.fd = s.fd;
    ex.files.push(...s.files);
    if (!ex.app && s.app) { ex.app = s.app; ex.alt = s.alt; }
    return fonts.get(ex.family);
  }
  let f = fonts.get(family);
  if (!f) { f = { family, styles: [] }; fonts.set(family, f); }
  s.family = family;
  s.alias = `typo-${++aliasSeq}`;
  s.files ??= [];
  s.alt ??= [];
  f.styles.push(s);
  if (s.ps) psIndex.set(s.ps, s);
  f.dirty = true;
  return f;
}

function noteCat(family, cat) {
  if (!cat || info[family]?.cat) return;
  info[family] = { ...info[family], cat };
  persistInfo();
}

const REGULAR = /^(regular|normal|book|roman|plain|medium)$/i;
function rep(f) { return f.styles.find((s) => REGULAR.test(s.style)) || f.styles.find((s) => !/italic|oblique/i.test(s.style)) || f.styles[0]; }

/** Registers a FontFace lazily (only for cards scrolled into view); returns the CSS alias. */
function ensureFace(s) {
  if (s.face) return s.alias;
  if (s.fd) {
    s.face = new FontFace(s.alias, `local("${s.ps.replace(/"/g, '')}"), local("${(s.full || '').replace(/"/g, '')}")`);
    document.fonts.add(s.face);
    s.face.load().catch(() => {});
  } else if (s.files[0]) {
    s.face = 'pending';
    s.files[0].blob.arrayBuffer()
      .then((buf) => { s.face = new FontFace(s.alias, buf); document.fonts.add(s.face); return s.face.load(); })
      .catch(() => {});
  }
  return s.alias;
}

/** Removes file references matching pred; drops styles/families that have nothing left. */
function removeFiles(pred) {
  for (const f of [...fonts.values()]) {
    f.styles = f.styles.filter((s) => {
      s.files = s.files.filter((x) => !pred(x));
      if (s.files.length || s.fd) return true;
      if (s.face instanceof FontFace) document.fonts.delete(s.face);
      if (s.ps) psIndex.delete(s.ps);
      return false;
    });
    f.dirty = true;
    if (!f.styles.length) fonts.delete(f.family);
  }
}

async function loadSystemFonts() {
  if (!('queryLocalFonts' in window)) {
    status('System font access needs a Chromium browser (Chrome / Edge / Arc / Brave). Font folders and dropped files still work.');
    return;
  }
  status('Reading system fonts…');
  let list;
  try { list = await window.queryLocalFonts(); }
  catch (e) { status(`System fonts unavailable: ${e.message}`); return; }
  if (!list.length) { status('No system fonts returned — allow "Local fonts" access for this page in the browser site settings, then try again.'); return; }
  systemLoaded = true;
  for (const fd of list) {
    const fam = junk(fd.family) ? (fd.fullName || fd.postscriptName) : fd.family;
    addStyle(fam, { style: fd.style, ps: fd.postscriptName, full: fd.fullName, fd });
  }
  rebuild();
  detectSystem();
}
let systemLoaded = false;

async function addDropped(name, blob, persist = true) {
  if ([...fonts.values()].some((f) => f.styles.some((s) => s.files.some((x) => x.dropped && x.name === name)))) return false;
  const inf = await inspect(blob, baseName(name));
  addStyle(inf.family, { style: inf.style, full: inf.full, ps: inf.ps, app: inf.app, alt: inf.alt,
    files: [{ name, path: name, blob, dropped: true }] });
  noteCat(inf.family, inf.cat);
  if (persist) await idb.put('files', name, blob);
  return true;
}

async function addFiles(files) {
  let n = 0;
  for (const file of files) {
    if (/\.(md|markdown|txt)$/i.test(file.name)) { importMarkdown(await file.text(), 'merge'); continue; }
    if (!FONT_RE.test(file.name)) continue;
    if (await addDropped(file.name, file)) n++;
  }
  if (n) { status(`Added ${n} font file${n > 1 ? 's' : ''}.`); rebuild(); }
}

/** Background classification + name reading of system fonts (cached in localStorage). */
async function detectSystem() {
  const todo = [...fonts.values()].filter((f) => rep(f).fd && !info[f.family]?.cat);
  let i = 0;
  for (const f of todo) {
    const s = rep(f);
    let inf = null;
    try { inf = await inspect(await s.fd.blob(), f.family); } catch {}
    info[f.family] = { cat: inf?.cat || guessByName(f.family), app: uniq([inf?.app]), alt: inf?.alt || [] };
    if (inf && !s.app) { s.app = inf.app; s.alt = inf.alt; }
    // An imported category equal to the detected one is not an override.
    if (meta[f.family]?.category === info[f.family].cat) { delete meta[f.family].category; if (!clean(f.family, meta[f.family])) delete meta[f.family]; }
    f.refresh?.();
    if (++i % 25 === 0) { persistInfo(); status(`Classifying… ${i}/${todo.length}`); renderSidebar(); await new Promise(requestAnimationFrame); }
  }
  persistInfo(); persistMeta(false);
  if (todo.length) { renderSidebar(); applyFilter(); }
}

/* ---------------------------------------------------------------- folders */

/** [{ id, handle, ok, count }] — directory handles persist in IndexedDB. */
let folders = [];

async function* walk(dir, prefix = '') {
  for await (const [name, h] of dir.entries()) {
    if (h.kind === 'directory') yield* walk(h, `${prefix}${name}/`);
    else if (FONT_RE.test(name)) yield [prefix + name, h];
  }
}

async function addFolder() {
  if (!('showDirectoryPicker' in window)) { status('Folders need a Chromium browser. Drop files instead.'); return; }
  let handle;
  try { handle = await showDirectoryPicker({ id: 'typo-fonts', mode: 'read' }); }
  catch (e) { if (e.name !== 'AbortError') status(e.message); return; }
  for (const fo of folders) if (await fo.handle.isSameEntry(handle)) { status(`${handle.name} is already added.`); return; }
  const fo = { id: crypto.randomUUID(), handle, ok: false, count: 0 };
  folders.push(fo);
  await saveFolders();
  await scanFolder(fo);
}

async function saveFolders() { await idb.put('kv', 'folders', folders.map(({ id, handle }) => ({ id, handle }))); }

async function scanFolder(fo, ask = false) {
  let perm = await fo.handle.queryPermission({ mode: 'read' });
  if (perm !== 'granted' && ask) perm = await fo.handle.requestPermission({ mode: 'read' });
  fo.ok = perm === 'granted';
  if (!fo.ok) { renderFolders(); return; }
  removeFiles((x) => x.folder === fo.id);
  let n = 0;
  status(`Scanning ${fo.handle.name}…`);
  try {
    for await (const [path, h] of walk(fo.handle)) {
      const file = await h.getFile();
      const inf = await inspect(file, baseName(path));
      addStyle(inf.family, { style: inf.style, full: inf.full, ps: inf.ps, app: inf.app, alt: inf.alt,
        files: [{ name: file.name, path: `${fo.handle.name}/${path}`, blob: file, folder: fo.id }] });
      noteCat(inf.family, inf.cat);
      if (++n % 50 === 0) status(`Scanning ${fo.handle.name}… ${n}`);
    }
  } catch (e) { status(`Error scanning ${fo.handle.name}: ${e.message}`); }
  fo.count = n;
  renderFolders();
  rebuild();
}

async function removeFolder(fo) {
  folders = folders.filter((x) => x !== fo);
  await saveFolders();
  removeFiles((x) => x.folder === fo.id);
  renderFolders();
  rebuild();
}

function renderFolders() {
  const list = $('#folderList');
  list.replaceChildren(...folders.map((fo) => el('li', {},
    el('span', { className: 'fname', textContent: fo.handle.name }),
    el('span', { className: 'muted small', textContent: fo.ok ? `${fo.count} files` : 'needs access' }),
    el('button', { textContent: fo.ok ? 'Rescan' : 'Reconnect', onclick: () => scanFolder(fo, true) }),
    el('button', { textContent: 'Remove', onclick: () => removeFolder(fo) }))));
  if (!folders.length) list.append(el('li', { className: 'muted small', textContent: 'No folders yet.' }));
  const pending = folders.filter((fo) => !fo.ok);
  const side = $('#folderStatus');
  side.replaceChildren();
  if (folders.length) side.append(`${folders.length} folder${folders.length > 1 ? 's' : ''}`);
  if (pending.length) side.append(' · ', el('button', { className: 'link', textContent: `reconnect ${pending.length}`,
    onclick: async () => { for (const fo of pending) await scanFolder(fo, true); } }));
}

/* ---------------------------------------------------------------- markdown */

function normCat(s) {
  const t = (s || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!t) return null;
  if (t.startsWith('sans')) return 'Sans-Serif';
  if (t.startsWith('serif')) return 'Serif';
  if (t.startsWith('mono')) return 'Monospace';
  if (t.startsWith('display') || t.startsWith('decorative')) return 'Display';
  if (t.startsWith('script') || t.startsWith('hand')) return 'Script/Handwriting';
  if (/^(cjk|hangul|korean|japanese|chinese)/.test(t)) return 'CJK';
  return null;
}
const normTag = (s) => s.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_\-/]/gu, '');
const filesOf = (f) => uniq(f.styles.flatMap((s) => s.files.map((x) => x.path)));

function exportMarkdown() {
  const fams = new Set(Object.keys(meta));
  if (settings.exportAll) for (const k of fonts.keys()) fams.add(k);
  const rows = [...fams].sort((a, b) => a.localeCompare(b));
  const entry = (fam) => {
    const x = m(fam), f = fonts.get(fam);
    const cat = x.category || (f ? category(fam) : '');
    const files = f ? filesOf(f) : [];
    return [
      `### ${fam}`,
      x.title ? `- **Title:** ${x.title}` : null,
      cat ? `- **Category:** ${cat}` : null,
      `- **Tags:** ${x.tags.map((t) => '#' + t).join(', ')}`.trimEnd(),
      `- **Status:** ${x.hidden ? 'hidden' : 'visible'}`,
      files.length ? `- **Files:** ${files.join(', ')}` : null,
      '',
    ].filter((l) => l != null).join('\n');
  };
  const active = rows.filter((f) => !m(f).hidden), hidden = rows.filter((f) => m(f).hidden);
  return [
    '---', 'version: 1.1', `exported: ${new Date().toISOString().slice(0, 10)}`, '---', '',
    '# Font Taxonomy', '',
    '## Active Fonts', '', ...active.map(entry),
    '## Hidden Fonts', '', ...hidden.map(entry),
  ].join('\n').replace(/\n+$/, '\n');
}

/** Parses the taxonomy format. Lenient: unknown lines/sections are ignored; Files is informational. */
function parseMarkdown(text) {
  const out = {};
  let section = 'visible', cur = null, inFront = false;
  text.replace(/\r/g, '').split('\n').forEach((line, i) => {
    if (line.trim() === '---' && (i === 0 || inFront)) { inFront = !inFront; return; }
    if (inFront) return;
    let mm;
    if ((mm = line.match(/^##\s+(.*)$/))) { section = /hidden/i.test(mm[1]) ? 'hidden' : 'visible'; cur = null; return; }
    if ((mm = line.match(/^###\s+(.+?)\s*$/))) { cur = mm[1]; out[cur] = { tags: [], hidden: section === 'hidden' }; return; }
    if (!cur) return;
    if ((mm = line.match(/^\s*[-*]\s*\*\*\s*([\w ]+?)\s*:?\s*\*\*\s*:?\s*(.*)$/))) {
      const key = mm[1].toLowerCase(), val = mm[2].trim();
      if (key === 'category') { const c = normCat(val); if (c) out[cur].category = c; }
      else if (key === 'title' || key === 'name') out[cur].title = val;
      else if (key === 'tags') out[cur].tags = uniq([...val.matchAll(/#([^\s,#]+)/g)].map((x) => normTag(x[1])));
      else if (key === 'status') out[cur].hidden = /hidden/i.test(val);
    }
  });
  return out;
}

/** mode 'merge' (file wins per font) or 'replace' (file is the whole truth). fromFile = don't echo back. */
function importMarkdown(text, mode = 'merge', fromFile = false) {
  const parsed = parseMarkdown(text);
  if (mode === 'replace') meta = {};
  for (const [fam, x] of Object.entries(parsed)) {
    // Only store a category as an override when it differs from what we'd detect anyway.
    const auto = info[fam]?.cat || (fonts.has(fam) ? guessByName(fam) : null);
    const e = clean(fam, { title: x.title, tags: x.tags, hidden: x.hidden, category: x.category !== auto ? x.category : undefined });
    if (e) meta[fam] = e; else delete meta[fam];
  }
  persistMeta(!fromFile);
  for (const f of fonts.values()) f.refresh?.();
  resort(); renderSidebar(); renderTagList(); applyFilter();
  return Object.keys(parsed).length;
}

function download(name, text) {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/markdown' })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* --------------------------------------- linked .md file: live, two-way sync */

let linked = null;      // FileSystemFileHandle
let linkedReady = false;
let writeTimer = 0, writing = false;
let lastText = null, lastMod = 0;
const MD_TYPES = [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }];

async function linkFile(existing) {
  if (!('showOpenFilePicker' in window)) { status('Linking needs a Chromium browser. Use Export / Import instead.'); return; }
  let handle;
  try {
    if (existing) [handle] = await showOpenFilePicker({ types: MD_TYPES });
    else handle = await showSaveFilePicker({ suggestedName: 'font-tags.md', types: MD_TYPES });
    if ((await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') return;
  } catch (e) { if (e.name !== 'AbortError') status(e.message); return; }
  linked = handle; linkedReady = true;
  await idb.put('kv', 'linked', handle);
  if (existing) await readLinked(true);
  await writeLinked();
  renderLink();
}

/** Reads the linked file; imports it if it changed since we last saw it. */
async function readLinked(force = false) {
  const file = await linked.getFile();
  if (!force && file.lastModified === lastMod) return false;
  lastMod = file.lastModified;
  const text = await file.text();
  if (!force && text === lastText) return false;
  lastText = text;
  importMarkdown(text, 'replace', true);
  return true;
}

async function reconnectLinked() {
  if (!linked) return;
  if ((await linked.requestPermission({ mode: 'readwrite' })) !== 'granted') return;
  linkedReady = true;
  await readLinked(true);
  renderLink('loaded');
}

async function pollLinked() {
  if (!linked || !linkedReady || !settings.watch || writing || document.hidden) return;
  try { if (await readLinked()) { renderLink(`reloaded ${new Date().toLocaleTimeString()}`); status('Linked .md changed on disk — reloaded.'); } }
  catch (e) { linkedReady = false; renderLink(); status(`Lost access to ${linked.name}: ${e.message}`); }
}

function scheduleLinkedWrite() {
  if (!linked || !linkedReady) return;
  clearTimeout(writeTimer);
  writeTimer = setTimeout(writeLinked, 600);
}
async function writeLinked() {
  if (!linked || !linkedReady) return;
  const text = exportMarkdown();
  if (text === lastText) return;
  writing = true;
  try {
    const w = await linked.createWritable();
    await w.write(text);
    await w.close();
    lastText = text;
    lastMod = (await linked.getFile()).lastModified;
    renderLink(`saved ${new Date().toLocaleTimeString()}`);
  } catch (e) { linkedReady = false; renderLink(); status(`Could not write ${linked.name}: ${e.message}`); }
  writing = false;
}

function renderLink(note = '') {
  const s = $('#linkStatus');
  s.replaceChildren();
  if (!linked) return;
  const unl = el('button', { className: 'link', textContent: 'unlink', onclick: unlink });
  if (linkedReady) s.append(`Synced with ${linked.name}${note ? ' · ' + note : ''} · `, unl);
  else s.append(`Linked: ${linked.name} · `, el('button', { className: 'link', textContent: 'reconnect', onclick: reconnectLinked }), ' · ', unl);
}
async function unlink() { linked = null; linkedReady = false; lastText = null; await idb.del('kv', 'linked'); renderLink(); }

setInterval(pollLinked, 1500);
addEventListener('focus', pollLinked);

/* ---------------------------------------------------------------- rendering */

const grid = $('#grid');
const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) {
    const f = fonts.get(e.target.dataset.family);
    if (f) e.target.querySelector('.sample').style.fontFamily = `"${ensureFace(rep(f))}", sans-serif`;
    io.unobserve(e.target);
  }
}, { rootMargin: '400px' });

function syncCat(f) {
  const sel = f.card?.querySelector('.cat'); if (!sel) return;
  const auto = info[f.family]?.cat || guessByName(f.family);
  sel.replaceChildren(el('option', { value: '', textContent: `Auto · ${auto}` }), ...CATS.map((c) => el('option', { value: c, textContent: c })));
  sel.value = m(f.family).category || '';
  sel.classList.toggle('auto', !sel.value);
}

function renderTags(f) {
  const box = f.card.querySelector('.tags');
  const input = box.querySelector('.tag-in');
  box.querySelectorAll('.tag').forEach((t) => t.remove());
  for (const t of m(f.family).tags) {
    const x = el('b', { textContent: '×', title: 'Remove tag' });
    x.onclick = (ev) => { ev.stopPropagation(); setMeta(f.family, { tags: m(f.family).tags.filter((y) => y !== t) }); renderTags(f); renderSidebar(); };
    const chip = el('span', { className: 'tag', title: 'Filter by this tag' }, '#' + t, x);
    chip.onclick = () => { filter.tags.has(t) ? filter.tags.delete(t) : filter.tags.add(t); renderSidebar(); applyFilter(); };
    box.insertBefore(chip, input);
  }
}

function sourceLabel(f) {
  const src = [];
  if (f.styles.some((s) => s.fd)) src.push('system');
  if (f.styles.some((s) => s.files.some((x) => x.folder))) src.push('folder');
  if (f.styles.some((s) => s.files.some((x) => x.dropped))) src.push('file');
  const n = f.styles.length;
  return `${n} style${n > 1 ? 's' : ''} · ${src.join(' + ')}`;
}

function buildCard(f) {
  const nameEl = el('button', { className: 'name', title: 'Show details' });
  const metaEl = el('span', { className: 'meta', title: 'Show details' });
  const hideBtn = el('button', { className: 'icon' });
  const rmBtn = el('button', { className: 'icon', textContent: '✕', title: 'Remove dropped font files' });
  const sel = el('select', { className: 'cat', title: 'Classification' });
  const sample = el('div', { className: 'sample', textContent: ui.text });
  const tagIn = el('input', { className: 'tag-in', placeholder: '+ tag', spellcheck: false });
  tagIn.setAttribute('list', 'tagList');
  const card = el('article', { className: 'card' },
    el('header', {}, nameEl, metaEl, sel, hideBtn, rmBtn),
    sample,
    el('div', { className: 'tags' }, tagIn));
  card.dataset.family = f.family;
  f.card = card;

  nameEl.onclick = metaEl.onclick = () => toggleDetails(f);
  sel.onchange = () => { setMeta(f.family, { category: sel.value || undefined }); syncCat(f); renderSidebar(); applyFilter(); };
  hideBtn.onclick = () => { setMeta(f.family, { hidden: !m(f.family).hidden }); f.refresh(); renderSidebar(); applyFilter(); };
  rmBtn.onclick = async () => {
    for (const s of f.styles) for (const x of s.files) if (x.dropped) await idb.del('files', x.name);
    removeFiles((x) => x.dropped && x.blob && f.styles.some((s) => s.files.includes(x)));
    rebuild();
  };

  const commit = () => {
    const add = tagIn.value.split(/[,\s]+/).map(normTag).filter(Boolean);
    tagIn.value = '';
    if (!add.length) return;
    setMeta(f.family, { tags: uniq([...m(f.family).tags, ...add]) });
    renderTags(f); renderSidebar(); renderTagList();
  };
  tagIn.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
    else if (e.key === 'Backspace' && !tagIn.value) {
      const t = m(f.family).tags; if (t.length) { setMeta(f.family, { tags: t.slice(0, -1) }); renderTags(f); renderSidebar(); }
    } else if (e.key === 'Escape') { tagIn.value = ''; tagIn.blur(); }
  };
  tagIn.onblur = commit;

  /** Re-syncs everything on the card from state (after imports, edits, detection). */
  f.refresh = () => {
    if (!f.card) return;
    const x = m(f.family);
    nameEl.textContent = title(f);
    nameEl.classList.toggle('renamed', !!x.title);
    nameEl.title = x.title ? `${f.family} — click for details` : 'Click for details';
    metaEl.textContent = sourceLabel(f);
    hideBtn.textContent = x.hidden ? 'unhide' : 'hide';
    hideBtn.title = x.hidden ? 'Show in workspace' : 'Hide from workspace';
    card.classList.toggle('is-hidden', !!x.hidden);
    rmBtn.hidden = !f.styles.some((s) => s.files.some((y) => y.dropped));
    syncCat(f);
    renderTags(f);
    const d = card.querySelector('.details');
    if (d) { d.remove(); toggleDetails(f); }
  };
  f.refresh();
  io.observe(card);
  return card;
}

/** Expandable details: editable title, the names apps show, other-language names, files, and every style. */
async function toggleDetails(f) {
  const existing = f.card.querySelector('.details');
  if (existing) { existing.remove(); return; }

  const row = (label, ...content) => el('div', { className: 'row' }, el('span', { className: 'k', textContent: label }), el('div', { className: 'v' }, ...content));
  const titleIn = el('input', { className: 'title-in', type: 'text', value: m(f.family).title || '', placeholder: f.family, spellcheck: false });
  const saveTitle = () => {
    if ((m(f.family).title || '') === titleIn.value.trim()) return;
    setMeta(f.family, { title: titleIn.value });
    f.card.querySelector('.name').textContent = title(f);
    f.card.querySelector('.name').classList.toggle('renamed', !!m(f.family).title);
    resort(); applyFilter();
  };
  titleIn.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); titleIn.blur(); }
    else if (e.key === 'Escape') { titleIn.value = m(f.family).title || ''; titleIn.blur(); }
  };
  titleIn.onblur = saveTitle;

  const box = el('div', { className: 'details' });
  const fill = () => {
    const apps = uniq([...f.styles.map((s) => s.app), ...(info[f.family]?.app || [])]);
    const alt = uniq([...f.styles.flatMap((s) => s.alt), ...(info[f.family]?.alt || [])]);
    const files = filesOf(f);
    const styles = el('div', { className: 'styles' });
    for (const s of [...f.styles].sort(styleOrder)) {
      const r = el('div', {}, el('span', { textContent: s.style, title: s.full }), ui.text.slice(0, 60) || ' ');
      r.style.fontFamily = `"${ensureFace(s)}"`;
      styles.append(r);
    }
    box.replaceChildren(
      row('Title', titleIn, el('div', { className: 'muted small', textContent: 'Your name for this font. Empty = use the font’s own name.' })),
      row('Family', f.family),
      row('In apps', apps.length ? apps.join(' · ') : el('span', { className: 'muted', textContent: '—' }),
        el('div', { className: 'muted small', textContent: 'Name Word, GIMP etc. list in their font menu' })),
      alt.length ? row('Other names', alt.join(' · ')) : null,
      row('Files', files.length ? el('ul', { className: 'files' }, ...files.map((p) => el('li', { textContent: p })))
        : el('span', { className: 'muted', textContent: 'Installed system font — add its folder in Settings to see file names' })),
      row('PostScript', uniq(f.styles.map((s) => s.ps)).join(', ') || '—'),
      styles,
    );
  };
  fill();
  f.card.querySelector('.sample').after(box);

  // System styles: read their name tables on demand to fill "In apps" / "Other names".
  const missing = f.styles.filter((s) => s.fd && !s.app && !s.files.length);
  if (missing.length) {
    for (const s of missing) {
      try { const inf = await inspect(await s.fd.blob(), f.family); s.app = inf.app; s.alt = inf.alt; } catch {}
    }
    if (box.isConnected && document.activeElement !== titleIn) fill();
  }
}

function styleOrder(a, b) {
  const w = (s) => { const t = (s.style || '').toLowerCase().replace(/[\s-]/g, '');
    const n = [['thin', 1], ['hairline', 1], ['extralight', 2], ['ultralight', 2], ['light', 3], ['regular', 4], ['book', 4], ['normal', 4], ['medium', 5], ['semibold', 6], ['demibold', 6], ['extrabold', 8], ['ultrabold', 8], ['bold', 7], ['black', 9], ['heavy', 9]]
      .find(([k]) => t.includes(k));
    return (n ? n[1] : 4) * 2 + (/italic|oblique/.test(t) ? 1 : 0); };
  return w(a) - w(b) || (a.style || '').localeCompare(b.style || '');
}

/** All the names a font can be found by: your title, family, app names, other-language names, file names. */
function haystack(f) {
  const i = info[f.family] || {};
  return [title(f), f.family, ...(i.app || []), ...(i.alt || []),
    ...f.styles.flatMap((s) => [s.app, s.full, ...s.alt, ...s.files.map((x) => x.path)])].join('\n').toLowerCase();
}

function visible(f) {
  const x = m(f.family);
  if (x.hidden && !ui.showHidden) return false;
  if (filter.q && !haystack(f).includes(filter.q)) return false;
  if (filter.cats.size && !filter.cats.has(category(f.family))) return false;
  for (const t of filter.tags) if (t === '∅' ? x.tags.length : !x.tags.includes(t)) return false;
  return true;
}

let sorted = [];
const resort = () => { sorted = [...fonts.values()].sort((a, b) => title(a).localeCompare(title(b), undefined, { sensitivity: 'base' })); };

function rebuild() {
  for (const f of fonts.values()) if (f.dirty) { f.dirty = false; f.refresh?.(); }
  resort();
  $('#empty').hidden = fonts.size > 0;
  renderSidebar();
  renderTagList();
  applyFilter();
  if (settings.exportAll) scheduleLinkedWrite();
}

function applyFilter() {
  const frag = document.createDocumentFragment();
  let n = 0;
  for (const f of sorted) if (visible(f)) { frag.append(f.card || buildCard(f)); n++; }
  grid.replaceChildren(frag);
  if (fonts.size) status(`${n} of ${fonts.size} families shown.`);
}

function chip(label, count, on, onclick) {
  const c = el('button', { className: 'chip' + (on ? ' on' : '') }, label, el('span', { className: 'n', textContent: count }));
  c.onclick = onclick;
  return c;
}

function renderSidebar() {
  const pool = [...fonts.values()].filter((f) => ui.showHidden || !m(f.family).hidden);
  const catN = Object.fromEntries(CATS.map((c) => [c, 0]));
  for (const f of pool) catN[category(f.family)]++;
  $('#cats').replaceChildren(...CATS.map((c) => chip(c, catN[c], filter.cats.has(c), () => {
    filter.cats.has(c) ? filter.cats.delete(c) : filter.cats.add(c); renderSidebar(); applyFilter();
  })));

  const tagN = {};
  for (const x of Object.values(meta)) if (!x.hidden || ui.showHidden) for (const t of x.tags) tagN[t] = (tagN[t] || 0) + 1;
  for (const t of filter.tags) if (t !== '∅') tagN[t] ??= 0;
  const untagged = pool.filter((f) => !m(f.family).tags.length).length;
  const toggle = (t) => () => { filter.tags.has(t) ? filter.tags.delete(t) : filter.tags.add(t); renderSidebar(); applyFilter(); };
  $('#tags').replaceChildren(
    ...Object.keys(tagN).sort().map((t) => chip('#' + t, tagN[t], filter.tags.has(t), toggle(t))),
    chip('untagged', untagged, filter.tags.has('∅'), toggle('∅')));
  $('#clearTags').hidden = !filter.tags.size && !filter.cats.size;

  const hid = [...fonts.keys()].filter((f) => m(f).hidden).length;
  $('#hiddenCount').textContent = hid ? `(${hid})` : '';
}

function renderTagList() {
  const all = new Set(Object.values(meta).flatMap((x) => x.tags));
  $('#tagList').replaceChildren(...[...all].sort().map((t) => el('option', { value: t })));
}

function status(s) { $('#status').textContent = s; }

/* ---------------------------------------------------------------- controls */

function applyUI() {
  const root = document.documentElement.style;
  root.setProperty('--size', ui.size + 'px');
  root.setProperty('--track', ui.track / 1000 + 'em');
  $('#sizeOut').textContent = ui.size;
  $('#trackOut').textContent = (ui.track / 1000).toFixed(3).replace(/\.?0+$/, '') || '0';
  grid.classList.toggle('list', ui.view === 'list');
  $('#viewGrid').classList.toggle('on', ui.view === 'grid');
  $('#viewList').classList.toggle('on', ui.view === 'list');
  save(LS_UI, ui);
}

function setText(t) {
  ui.text = t;
  const shown = t || ' ';
  for (const f of fonts.values()) if (f.card) {
    f.card.querySelector('.sample').textContent = shown;
    f.card.querySelectorAll('.styles div').forEach((r) => { r.lastChild.textContent = shown.slice(0, 60); });
  }
  save(LS_UI, ui);
}

$('#sample').value = ui.text;
$('#size').value = ui.size;
$('#track').value = ui.track;
$('#showHidden').checked = ui.showHidden;

$('#sample').oninput = (e) => setText(e.target.value);
$('#preset').onchange = (e) => { if (e.target.value) { $('#sample').value = e.target.value; setText(e.target.value); } e.target.value = ''; };
$('#size').oninput = (e) => { ui.size = +e.target.value; applyUI(); };
$('#track').oninput = (e) => { ui.track = +e.target.value; applyUI(); };
$('#viewGrid').onclick = () => { ui.view = 'grid'; applyUI(); };
$('#viewList').onclick = () => { ui.view = 'list'; applyUI(); };
$('#showHidden').onchange = (e) => { ui.showHidden = e.target.checked; save(LS_UI, ui); renderSidebar(); applyFilter(); };
$('#search').oninput = (e) => { filter.q = e.target.value.trim().toLowerCase(); applyFilter(); };
$('#clearTags').onclick = () => { filter.tags.clear(); filter.cats.clear(); renderSidebar(); applyFilter(); };

$('#loadSystem').onclick = $('#emptyLoad').onclick = () => {
  if (systemLoaded) { status('System fonts already loaded.'); return; }
  loadSystemFonts();
};
$('#addFolder').onclick = $('#addFolder2').onclick = $('#emptyFolder').onclick = addFolder;
$('#addFiles').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
$('#exportMd').onclick = () => download('font-tags.md', exportMarkdown());
$('#importMd').onclick = () => $('#mdInput').click();
$('#mdInput').onchange = async (e) => {
  const f = e.target.files[0];
  if (f) status(`Imported ${importMarkdown(await f.text(), 'merge')} font entries (one-time copy — use Link for live sync).`);
  e.target.value = '';
};
$('#linkMd').onclick = () => linkFile(true);
$('#newMd').onclick = () => linkFile(false);

// Settings dialog
$('#openSettings').onclick = () => { renderFolders(); $('#settings').showModal(); };
$('#setSystem').checked = settings.systemOnStart;
$('#setWatch').checked = settings.watch;
$(settings.exportAll ? '#scopeAll' : '#scopeAnn').checked = true;
const saveSettings = () => save(LS_SET, settings);
$('#setSystem').onchange = (e) => { settings.systemOnStart = e.target.checked; saveSettings(); };
$('#setWatch').onchange = (e) => { settings.watch = e.target.checked; saveSettings(); };
for (const r of document.querySelectorAll('input[name=scope]')) r.onchange = () => {
  settings.exportAll = $('#scopeAll').checked; saveSettings(); scheduleLinkedWrite();
};
$('#redetect').onclick = () => { localStorage.removeItem(LS_INFO); location.reload(); };
$('#clearDropped').onclick = async () => {
  if (!confirm('Remove all font files you dropped into Typo? (Folder and system fonts are not affected.)')) return;
  await idb.clear('files');
  removeFiles((x) => x.dropped);
  rebuild();
};
$('#resetMeta').onclick = () => {
  if (!confirm('Clear every title, tag, classification override and hidden flag? A linked .md file will be emptied too.')) return;
  meta = {}; persistMeta();
  for (const f of fonts.values()) f.refresh?.();
  rebuild();
};

document.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  if (e.key === '/' && !typing) { e.preventDefault(); $('#search').focus(); }
  else if (e.key === 'Escape' && document.activeElement === $('#search')) { $('#search').value = ''; filter.q = ''; applyFilter(); $('#search').blur(); }
});

// Drag & drop anywhere
let dragDepth = 0;
addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; $('#drop').classList.add('on'); } });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').classList.remove('on'); } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; $('#drop').classList.remove('on'); addFiles(e.dataTransfer.files); });

/* -------------------------------------------------------------------- boot */

(async function boot() {
  applyUI();
  // 1. A linked .md file is the source of truth: read it before anything can write to it.
  try {
    linked = (await idb.get('kv', 'linked')) || null;
    if (linked && (await linked.queryPermission({ mode: 'readwrite' })) === 'granted') { linkedReady = true; await readLinked(true); }
  } catch (e) { console.warn(e); }
  renderLink();
  // 2. Dropped files, then folders.
  try {
    for (const [name, v] of await idb.all('files')) await addDropped(name, v instanceof Blob ? v : new Blob([v]), false);
  } catch (e) { console.warn(e); }
  try {
    folders = ((await idb.get('kv', 'folders')) || []).map((x) => ({ ...x, ok: false, count: 0 }));
    for (const fo of folders) await scanFolder(fo);
  } catch (e) { console.warn(e); }
  renderFolders();
  rebuild();
  // 3. System fonts, if enabled and permission was granted before.
  if (settings.systemOnStart && 'queryLocalFonts' in window) {
    try { if ((await navigator.permissions.query({ name: 'local-fonts' })).state === 'granted') loadSystemFonts(); } catch {}
  }
})();
