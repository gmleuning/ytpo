/* Typo — minimal local-first font browser.
 * No build step, no dependencies. State lives in localStorage + IndexedDB,
 * and round-trips through a human-editable Markdown file. */
'use strict';

const CATS = ['Serif', 'Sans-Serif', 'Monospace', 'Display', 'Script/Handwriting'];
const LS_META = 'typo.meta.v1';
const LS_DETECT = 'typo.detect.v1';
const LS_UI = 'typo.ui.v1';

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k != null) n.append(k);
  return n;
};
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

/* ------------------------------------------------------------------ state */

/** family -> { category?: string, tags: string[], hidden?: bool } (user metadata) */
let meta = load(LS_META, {});
/** family -> auto-detected category (cache across sessions) */
const detected = load(LS_DETECT, {});
/** family -> { family, styles: [{ style, alias, src, data? }], sources: Set, card? } */
const fonts = new Map();

const ui = Object.assign({
  text: 'The quick brown fox jumps over the lazy dog',
  size: 48, track: 0, view: 'grid', showHidden: false,
}, load(LS_UI, {}));
const filter = { q: '', cats: new Set(), tags: new Set() };

let aliasSeq = 0;

function m(family) { return meta[family] || { tags: [] }; }
function setMeta(family, patch) {
  const cur = { tags: [], ...meta[family], ...patch };
  if (!cur.category) delete cur.category;
  if (!cur.hidden) delete cur.hidden;
  if (!cur.tags.length && !cur.category && !cur.hidden) delete meta[family];
  else meta[family] = cur;
  persistMeta();
}
function category(family) { return m(family).category || detected[family] || guessByName(family); }

function persistMeta() {
  save(LS_META, meta);
  scheduleLinkedWrite();
}

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
    all: async (s) => {
      const keys = await tx(s, 'readonly', (o) => o.getAllKeys());
      const vals = await tx(s, 'readonly', (o) => o.getAll());
      return keys.map((k, i) => [k, vals[i]]);
    },
  };
})();

/* ------------------------------------------------------- sfnt / woff parsing */

/** reader(offset, length) -> Promise<DataView>. Works for ArrayBuffers and lazily-sliced Blobs. */
const bufReader = (buf) => async (o, l) => new DataView(buf, o, Math.min(l, buf.byteLength - o));
const blobReader = (blob) => async (o, l) => new DataView(await blob.slice(o, o + l).arrayBuffer());
const tag4 = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));

async function inflate(dv) {
  const ds = new DecompressionStream('deflate');
  const out = new Response(new Blob([dv]).stream().pipeThrough(ds));
  return new DataView(await out.arrayBuffer());
}

/** Returns { get(tag) -> Promise<DataView|null> } or null for unsupported formats (e.g. woff2). */
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

async function readNames(font) {
  const dv = await font.get('name'); if (!dv) return {};
  const count = dv.getUint16(2), strOff = dv.getUint16(4);
  const best = {};
  for (let i = 0; i < count; i++) {
    const p = 6 + i * 12;
    const plat = dv.getUint16(p), lang = dv.getUint16(p + 4), id = dv.getUint16(p + 6);
    const len = dv.getUint16(p + 8), off = dv.getUint16(p + 10);
    if (![1, 2, 4, 16, 17].includes(id)) continue;
    let score = plat === 3 ? (lang === 0x409 ? 3 : 1) : plat === 1 && lang === 0 ? 2 : 0;
    if (score === 0 && plat !== 0) continue;
    if ((best[id]?.score ?? -1) >= score) continue;
    let s = '';
    const start = strOff + off;
    if (start + len > dv.byteLength) continue;
    if (plat === 3 || plat === 0) for (let j = 0; j < len; j += 2) s += String.fromCharCode(dv.getUint16(start + j));
    else for (let j = 0; j < len; j++) s += String.fromCharCode(dv.getUint8(start + j));
    best[id] = { score, s };
  }
  const g = (id) => best[id]?.s;
  return { family: g(16) || g(1), style: g(17) || g(2), full: g(4) };
}

/** Classify from OS/2 sFamilyClass + PANOSE + post.isFixedPitch. Returns a category or null. */
async function classifyTables(font, family) {
  if (/mono|code|courier|consol|terminal|fixed|typewriter/i.test(family)) return 'Monospace';
  const post = await font.get('post');
  if (post && post.byteLength >= 16 && post.getUint32(12) !== 0) return 'Monospace';
  const os2 = await font.get('OS/2');
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
  if (/mono|code|courier|consol|terminal|fixed|typewriter/i.test(f)) return 'Monospace';
  if (/script|hand|brush|callig|marker|comic|signature|ink free|segoe print|pen\b|chancery|kunstler|vivaldi|edwardian/i.test(f)) return 'Script/Handwriting';
  if (/display|poster|stencil|deco|impact|headline|black ?letter|fraktur|showcard|jokerman|chiller|symbol|dings|emoji|icons?\b|webdings|wingdings|marlett/i.test(f)) return 'Display';
  if (/sans|gothic|grotesk|grotesque|dotum|gulim|hei\b|arial|helvetica|verdana|tahoma|segoe|inter\b|roboto|calibri|candara|corbel|futura|gill/i.test(f)) return 'Sans-Serif';
  if (/serif|roman|times|garamond|georgia|baskerville|bodoni|caslon|didot|antiqua|cambria|constantia|minion|palatino|song|ming|batang|myeongjo|mincho|book\b|century|bookman|sylfaen|old style/i.test(f)) return 'Serif';
  return 'Sans-Serif';
}

/* -------------------------------------------------------------- font sources */

function addStyle(family, style) {
  let f = fonts.get(family);
  if (!f) { f = { family, styles: [], sources: new Set() }; fonts.set(family, f); }
  f.styles.push(style);
  f.sources.add(style.src);
  return f;
}

const REGULAR = /^(regular|normal|book|roman|plain|medium)$/i;
function rep(f) { return f.styles.find((s) => REGULAR.test(s.style)) || f.styles.find((s) => !/italic|oblique/i.test(s.style)) || f.styles[0]; }

/** Registers a FontFace lazily; returns alias family name usable in CSS. */
function ensureFace(s) {
  if (s.face) return s.alias;
  const source = s.src === 'system' ? `local("${s.ps.replace(/"/g, '')}"), local("${s.full.replace(/"/g, '')}")` : s.data;
  s.face = new FontFace(s.alias, source);
  document.fonts.add(s.face);
  s.face.load().catch(() => { s.broken = true; });
  return s.alias;
}

async function loadSystemFonts() {
  if (!('queryLocalFonts' in window)) {
    status('System font access needs a Chromium browser (Chrome / Edge / Arc / Brave). You can still add font files.');
    return;
  }
  status('Reading system fonts…');
  let list;
  try { list = await window.queryLocalFonts(); }
  catch (e) { status(`System fonts unavailable: ${e.message}`); return; }
  if (!list.length) { status('No system fonts returned — allow "Local fonts" access for this page in the browser site settings, then try again.'); return; }
  const seen = new Set();
  for (const fd of list) {
    if (seen.has(fd.postscriptName)) continue;
    seen.add(fd.postscriptName);
    addStyle(fd.family, { style: fd.style, ps: fd.postscriptName, full: fd.fullName, src: 'system', alias: `typo-${++aliasSeq}`, fd });
  }
  ui.system = true;
  save(LS_UI, ui);
  status(`${fonts.size} families loaded.`);
  rebuild();
  detectAll();
}

async function addFontFile(name, buf, persist = true) {
  let family = name.replace(/\.(ttf|otf|woff2?|ttc)$/i, ''), style = 'Regular', font = null;
  try {
    font = await openFont(bufReader(buf));
    if (font) { const n = await readNames(font); family = n.family || family; style = n.style || style; }
  } catch {}
  const f = addStyle(family, { style, full: `${family} ${style}`, src: 'file', file: name, alias: `typo-${++aliasSeq}`, data: buf });
  if (font && !detected[family]) {
    try { const c = await classifyTables(font, family); if (c) { detected[family] = c; save(LS_DETECT, detected); } } catch {}
  }
  if (persist) await idb.put('files', name, buf);
  return f;
}

async function addFiles(files) {
  let n = 0;
  for (const file of files) {
    if (/\.(md|markdown|txt)$/i.test(file.name)) { importMarkdown(await file.text()); continue; }
    if (!/\.(ttf|otf|woff2?|ttc)$/i.test(file.name)) continue;
    await addFontFile(file.name, await file.arrayBuffer());
    n++;
  }
  if (n) { status(`Added ${n} font file${n > 1 ? 's' : ''}.`); rebuild(); }
}

async function removeFileFamily(f) {
  for (const s of f.styles.filter((s) => s.src === 'file')) {
    await idb.del('files', s.file);
    if (s.face) document.fonts.delete(s.face);
  }
  f.styles = f.styles.filter((s) => s.src !== 'file');
  f.sources.delete('file');
  if (!f.styles.length) fonts.delete(f.family);
  f.card = null;
  rebuild();
}

/** Background classification of system fonts from their binary tables (cached). */
async function detectAll() {
  const todo = [...fonts.values()].filter((f) => !(f.family in detected) && rep(f).fd);
  let i = 0;
  for (const f of todo) {
    let c = null;
    try {
      const blob = await rep(f).fd.blob();
      const font = await openFont(blobReader(blob));
      if (font) c = await classifyTables(font, f.family);
    } catch {}
    detected[f.family] = c || guessByName(f.family);
    if (f.card) syncCat(f);
    if (++i % 25 === 0) { save(LS_DETECT, detected); status(`Classifying… ${i}/${todo.length}`); renderSidebar(); await new Promise(requestAnimationFrame); }
  }
  save(LS_DETECT, detected);
  if (todo.length) { status(`${fonts.size} families loaded.`); applyFilter(); }
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
  return null;
}
const normTag = (s) => s.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_\-/]/gu, '');

function exportMarkdown() {
  const rows = Object.keys(meta).sort((a, b) => a.localeCompare(b));
  const entry = (fam) => {
    const x = meta[fam];
    const cat = x.category || (fonts.has(fam) ? category(fam) : '');
    return [
      `### ${fam}`,
      cat ? `- **Category:** ${cat}` : null,
      `- **Tags:** ${x.tags.map((t) => '#' + t).join(', ')}`.trimEnd(),
      `- **Status:** ${x.hidden ? 'hidden' : 'visible'}`,
      '',
    ].filter((l) => l != null).join('\n');
  };
  const active = rows.filter((f) => !meta[f].hidden), hidden = rows.filter((f) => meta[f].hidden);
  return [
    '---', 'version: 1.0', `exported: ${new Date().toISOString().slice(0, 10)}`, '---', '',
    '# Font Taxonomy', '',
    '## Active Fonts', '', ...active.map(entry),
    '## Hidden Fonts', '', ...hidden.map(entry),
  ].join('\n').replace(/\n+$/, '\n');
}

/** Parses the taxonomy format. Lenient: unknown lines/sections are ignored. */
function parseMarkdown(text) {
  const out = {};
  let section = 'visible', cur = null, inFront = false;
  const lines = text.replace(/\r/g, '').split('\n');
  lines.forEach((line, i) => {
    if (line.trim() === '---' && (i === 0 || inFront)) { inFront = !inFront; return; }
    if (inFront) return;
    let mm;
    if ((mm = line.match(/^##\s+(.*)$/)) && !line.startsWith('###')) {
      section = /hidden/i.test(mm[1]) ? 'hidden' : 'visible'; cur = null; return;
    }
    if ((mm = line.match(/^###\s+(.+?)\s*$/))) {
      cur = mm[1]; out[cur] = { tags: [], hidden: section === 'hidden' }; return;
    }
    if (!cur) return;
    if ((mm = line.match(/^\s*[-*]\s*\*\*\s*([\w ]+?)\s*:?\s*\*\*\s*:?\s*(.*)$/))) {
      const key = mm[1].toLowerCase(), val = mm[2];
      if (key === 'category') { const c = normCat(val); if (c) out[cur].category = c; }
      else if (key === 'tags') out[cur].tags = [...new Set([...val.matchAll(/#([^\s,#]+)/g)].map((x) => normTag(x[1])).filter(Boolean))];
      else if (key === 'status') out[cur].hidden = /hidden/i.test(val);
    }
  });
  return out;
}

/** Imports metadata. mode 'merge' (file wins per font) or 'replace'. */
function importMarkdown(text, mode = 'merge') {
  const parsed = parseMarkdown(text);
  if (mode === 'replace') meta = {};
  for (const [fam, x] of Object.entries(parsed)) {
    // Only store the category as an override when it differs from what we'd detect anyway.
    const auto = detected[fam] || (fonts.has(fam) ? guessByName(fam) : null);
    const entry = { tags: x.tags, hidden: x.hidden, category: x.category && x.category !== auto ? x.category : undefined };
    meta[fam] = entry;
    if (!entry.category) delete entry.category;
    if (!entry.hidden) delete entry.hidden;
    if (!entry.tags.length && !entry.category && !entry.hidden) delete meta[fam];
  }
  persistMeta();
  for (const f of fonts.values()) f.card = null;
  rebuild();
  status(`Imported ${Object.keys(parsed).length} font entries.`);
}

function download(name, text) {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/markdown' })), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* --------------------------------------------- linked .md file (File System Access) */

let linked = null; // FileSystemFileHandle
let linkedReady = false;
let writeTimer = 0;

async function linkFile() {
  if (!('showOpenFilePicker' in window)) { status('Linking needs a Chromium browser. Use Export / Import instead.'); return; }
  let handle;
  try {
    const choice = confirm('OK = link an EXISTING .md file (its contents are imported first).\nCancel = create a NEW file from the current taxonomy.');
    if (choice) [handle] = await showOpenFilePicker({ types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }] });
    else handle = await showSaveFilePicker({ suggestedName: 'font-tags.md', types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }] });
    if ((await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') return;
    if (choice) importMarkdown(await (await handle.getFile()).text(), 'replace');
  } catch (e) { if (e.name !== 'AbortError') status(e.message); return; }
  linked = handle; linkedReady = true;
  await idb.put('kv', 'linked', handle);
  await writeLinked();
  renderLink();
}

async function reconnectLinked() {
  if (!linked) return;
  if ((await linked.requestPermission({ mode: 'readwrite' })) !== 'granted') return;
  importMarkdown(await (await linked.getFile()).text(), 'replace');
  linkedReady = true;
  renderLink();
}

function scheduleLinkedWrite() {
  if (!linked || !linkedReady) return;
  clearTimeout(writeTimer);
  writeTimer = setTimeout(writeLinked, 600);
}
async function writeLinked() {
  try {
    const w = await linked.createWritable();
    await w.write(exportMarkdown());
    await w.close();
    renderLink(`saved ${new Date().toLocaleTimeString()}`);
  } catch (e) { linkedReady = false; renderLink(); status(`Could not write ${linked.name}: ${e.message}`); }
}

function renderLink(note = '') {
  const s = $('#linkStatus');
  s.replaceChildren();
  if (!linked) return;
  if (linkedReady) {
    s.append(`Synced to ${linked.name}${note ? ' · ' + note : ''} `, el('button', { className: 'link', textContent: 'unlink', onclick: unlink }));
  } else {
    s.append(`Linked: ${linked.name} `, el('button', { className: 'link', textContent: 'reconnect', onclick: reconnectLinked }), ' · ',
      el('button', { className: 'link', textContent: 'unlink', onclick: unlink }));
  }
}
async function unlink() { linked = null; linkedReady = false; await idb.del('kv', 'linked'); renderLink(); }

/* ---------------------------------------------------------------- rendering */

const grid = $('#grid');
const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) {
    const f = fonts.get(e.target.dataset.family);
    if (f) { const s = rep(f); e.target.querySelector('.sample').style.fontFamily = `"${ensureFace(s)}", sans-serif`; }
    io.unobserve(e.target);
  }
}, { rootMargin: '400px' });

function catSelect(f) {
  const sel = el('select', { className: 'cat', title: 'Classification' });
  sel.onchange = () => { setMeta(f.family, { category: sel.value || undefined }); syncCat(f); renderSidebar(); applyFilter(); };
  return sel;
}
function syncCat(f) {
  const sel = f.card?.querySelector('.cat'); if (!sel) return;
  const auto = detected[f.family] || guessByName(f.family);
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

function buildCard(f) {
  const hideBtn = el('button', { className: 'icon' });
  const metaEl = el('span', { className: 'meta', title: 'Show styles' });
  const sample = el('div', { className: 'sample', textContent: ui.text });
  const tagIn = el('input', { className: 'tag-in', placeholder: '+ tag', spellcheck: false });
  tagIn.setAttribute('list', 'tagList');
  const card = el('article', { className: 'card' },
    el('header', {}, el('span', { className: 'name', textContent: f.family, title: f.family }), metaEl, catSelect(f), hideBtn),
    sample,
    el('div', { className: 'tags' }, tagIn));
  card.dataset.family = f.family;
  f.card = card;

  const files = f.styles.filter((s) => s.src === 'file').length;
  metaEl.textContent = `${f.styles.length} style${f.styles.length > 1 ? 's' : ''}${files ? ' · file' : ''}`;
  metaEl.onclick = () => toggleStyles(f);

  if (files) {
    const rm = el('button', { className: 'icon', textContent: '✕', title: 'Remove loaded font files' });
    rm.onclick = () => removeFileFamily(f);
    hideBtn.after(rm);
  }

  const syncHide = () => {
    const h = !!m(f.family).hidden;
    hideBtn.textContent = h ? 'unhide' : 'hide';
    hideBtn.title = h ? 'Show in workspace' : 'Hide from workspace';
    card.classList.toggle('is-hidden', h);
  };
  hideBtn.onclick = () => { setMeta(f.family, { hidden: !m(f.family).hidden }); syncHide(); renderSidebar(); applyFilter(); };
  syncHide();

  const commit = () => {
    const add = tagIn.value.split(/[,\s]+/).map(normTag).filter(Boolean);
    tagIn.value = '';
    if (!add.length) return;
    setMeta(f.family, { tags: [...new Set([...m(f.family).tags, ...add])] });
    renderTags(f); renderSidebar(); renderTagList();
  };
  tagIn.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
    else if (e.key === 'Backspace' && !tagIn.value) {
      const t = m(f.family).tags; if (t.length) { setMeta(f.family, { tags: t.slice(0, -1) }); renderTags(f); renderSidebar(); }
    } else if (e.key === 'Escape') { tagIn.value = ''; tagIn.blur(); }
  };
  tagIn.onblur = commit;

  syncCat(f);
  renderTags(f);
  io.observe(card);
  return card;
}

function toggleStyles(f) {
  const existing = f.card.querySelector('.styles');
  if (existing) { existing.remove(); return; }
  const box = el('div', { className: 'styles' });
  for (const s of [...f.styles].sort(styleOrder)) {
    const row = el('div', {}, el('span', { textContent: s.style, title: s.full }), ui.text.slice(0, 60));
    row.style.fontFamily = `"${ensureFace(s)}"`;
    box.append(row);
  }
  f.card.querySelector('.sample').after(box);
}
function styleOrder(a, b) {
  const w = (s) => { const t = s.style.toLowerCase();
    const n = [['thin', 1], ['hairline', 1], ['extralight', 2], ['ultralight', 2], ['light', 3], ['regular', 4], ['book', 4], ['normal', 4], ['medium', 5], ['semibold', 6], ['demibold', 6], ['extrabold', 8], ['ultrabold', 8], ['bold', 7], ['black', 9], ['heavy', 9]]
      .find(([k]) => t.replace(/[\s-]/g, '').includes(k));
    return (n ? n[1] : 4) * 2 + (/italic|oblique/.test(t) ? 1 : 0); };
  return w(a) - w(b) || a.style.localeCompare(b.style);
}

function visible(f) {
  const x = m(f.family);
  if (x.hidden && !ui.showHidden) return false;
  if (filter.q && !f.family.toLowerCase().includes(filter.q)) return false;
  if (filter.cats.size && !filter.cats.has(category(f.family))) return false;
  for (const t of filter.tags) {
    if (t === '∅' ? x.tags.length : !x.tags.includes(t)) return false;
  }
  return true;
}

let sorted = [];
function rebuild() {
  sorted = [...fonts.values()].sort((a, b) => a.family.localeCompare(b.family));
  $('#empty').hidden = fonts.size > 0;
  renderSidebar();
  renderTagList();
  applyFilter();
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
  for (const [fam, x] of Object.entries(meta)) if (!x.hidden || ui.showHidden) for (const t of x.tags) tagN[t] = (tagN[t] || 0) + 1;
  for (const t of filter.tags) if (t !== '∅') tagN[t] ??= 0;
  const untagged = pool.filter((f) => !m(f.family).tags.length).length;
  const tagChips = Object.keys(tagN).sort().map((t) => chip('#' + t, tagN[t], filter.tags.has(t), () => {
    filter.tags.has(t) ? filter.tags.delete(t) : filter.tags.add(t); renderSidebar(); applyFilter();
  }));
  tagChips.push(chip('untagged', untagged, filter.tags.has('∅'), () => {
    filter.tags.has('∅') ? filter.tags.delete('∅') : filter.tags.add('∅'); renderSidebar(); applyFilter();
  }));
  $('#tags').replaceChildren(...tagChips);
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
  if ([...fonts.values()].some((f) => f.sources.has('system'))) { status('System fonts already loaded.'); return; }
  loadSystemFonts();
};
$('#addFiles').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
$('#exportMd').onclick = () => download('font-tags.md', exportMarkdown());
$('#importMd').onclick = () => $('#mdInput').click();
$('#mdInput').onchange = async (e) => { const f = e.target.files[0]; if (f) importMarkdown(await f.text()); e.target.value = ''; };
$('#linkMd').onclick = linkFile;

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
  try {
    for (const [name, buf] of await idb.all('files')) await addFontFile(name, buf, false);
    linked = (await idb.get('kv', 'linked')) || null;
    if (linked && (await linked.queryPermission({ mode: 'readwrite' })) === 'granted') linkedReady = true;
  } catch (e) { console.warn(e); }
  renderLink();
  rebuild();
  // Re-load system fonts automatically if permission was granted before.
  if (ui.system && 'queryLocalFonts' in window) {
    try {
      const p = await navigator.permissions.query({ name: 'local-fonts' });
      if (p.state === 'granted') loadSystemFonts();
    } catch {}
  }
})();
