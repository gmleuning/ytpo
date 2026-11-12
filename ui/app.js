/* Typo — minimal local-first font browser (desktop UI).
 * The Rust side (src-tauri) finds and reads font files, edits them, and reads/writes the .md file.
 * Typo's own data (labels, tags, overrides, hidden) lives in localStorage and the Markdown file. */
'use strict';

const T = window.__TAURI__;
const invoke = (cmd, args) => T.core.invoke(cmd, args);
const fileUrl = (p) => T.core.convertFileSrc(p);

const CATS = ['Serif', 'Sans-Serif', 'Monospace', 'Display', 'Script/Handwriting', 'CJK'];
const SOURCES = { windows: 'Windows (all users)', user: 'Installed by you', folder: 'Folders', file: 'Added files' };
const LS_META = 'typo.meta.v1';
const LS_UI = 'typo.ui.v1';
const LS_SET = 'typo.settings.v2';
const MD_FILTER = [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }];
const FONT_EXT = ['ttf', 'otf', 'ttc', 'otc', 'woff', 'woff2'];
const MONO_RE = /mono|code|courier|consol|terminal|fixed|typewriter/i;
const CJK_RE = /[\u1100-\u11ff\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]|\b(cjk|kr|jp|sc|tc|hk)\b|myeongjo|batang|gulim|dotum|gungsuh|nanum|malgun|mincho|meiryo|yu gothic|ms p?gothic|ms p?mincho|simsun|simhei|kaiti|fangsong|mingliu|yahei|jhenghei|dengxian|hiragino|source han|pretendard|spoqa/i;

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k != null) n.append(k);
  return n;
};
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const uniq = (a) => [...new Set(a.filter(Boolean))];
const fileName = (p) => p.replace(/^.*[\\/]/, '');
const dirName = (p) => p.replace(/[\\/][^\\/]*$/, '');

/* ------------------------------------------------------------------ state */

/** family -> { title?, category?, tags: string[], hidden? }  (keyed by the font's real family name) */
let meta = load(LS_META, {});
/** family -> { family, cat, styles: Style[], card?, refresh? }
 *  Style: { family, style, full, ps, app, alt[], files: File[] }
 *  File:  { path, index, source, folder, editable, mtime } */
let fonts = new Map();

const ui = Object.assign({
  text: 'The quick brown fox jumps over the lazy dog',
  size: 48, track: 0, view: 'grid', showHidden: false,
}, load(LS_UI, {}));
const settings = Object.assign({
  installed: true, folders: [], files: [], exportAll: true, watch: true, linked: null,
}, load(LS_SET, {}));
const filter = { q: '', cats: new Set(), tags: new Set(), sources: new Set() };
const saveSettings = () => save(LS_SET, settings);

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
const autoCat = (family) => fonts.get(family)?.cat || guessByName(family);
const category = (family) => m(family).category || autoCat(family);

function persistMeta(write = true) {
  save(LS_META, meta);
  if (write) scheduleLinkedWrite();
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

/* --------------------------------------------------------------- scanning */

let scanning = null;

/** Asks the Rust side for every font (installed + folders + files) and rebuilds the library. */
async function rescan() {
  if (scanning) return scanning;
  scanning = (async () => {
    status('Scanning fonts…');
    const t0 = performance.now();
    let res;
    try {
      res = await invoke('scan_fonts', { folders: settings.folders, files: settings.files, installed: settings.installed });
    } catch (e) { status(`Scan failed: ${e}`); return; }
    ingest(res.faces);
    for (const f of fonts.values()) if (f.cat && meta[f.family]?.category === f.cat) {
      delete meta[f.family].category;   // an imported category equal to the detected one isn't an override
      if (!clean(f.family, meta[f.family])) delete meta[f.family];
    }
    persistMeta(false);
    rebuild();
    const ms = Math.round(performance.now() - t0);
    status(`${fonts.size} families from ${res.faces.length} faces (${ms} ms).` + (res.errors.length ? ` ${res.errors.length} problem(s) — see Settings.` : ''));
    lastErrors = res.errors;
    renderFolders();
  })();
  try { await scanning; } finally { scanning = null; }
}
let lastErrors = [];

function ingest(faces) {
  const old = fonts;
  fonts = new Map();
  const byPs = new Map();
  for (const fc of faces) {
    const file = { path: fc.path, index: fc.index, source: fc.source, folder: fc.folder, editable: fc.editable, mtime: fc.mtime };
    if (fc.ps && byPs.has(fc.ps)) { byPs.get(fc.ps).files.push(file); continue; }
    let f = fonts.get(fc.family);
    if (!f) { f = { family: fc.family, cat: null, styles: [] }; fonts.set(fc.family, f); }
    const s = { family: fc.family, style: fc.style, full: fc.full, ps: fc.ps, app: fc.app, alt: fc.alt || [], cat: fc.cat, files: [file] };
    f.styles.push(s);
    if (fc.ps) byPs.set(fc.ps, s);
  }
  for (const f of fonts.values()) {
    f.cat = rep(f).cat || f.styles.find((s) => s.cat)?.cat || null;
    // Keep existing cards when the family survived, so scrolling position and open panels aren't lost.
    const prev = old.get(f.family);
    if (prev?.card) { f.card = prev.card; f.refresh = prev.refresh; f.rebind = prev.rebind; f.rebind(f); }
  }
}

const REGULAR = /^(regular|normal|book|roman|plain|medium)$/i;
function rep(f) { return f.styles.find((s) => REGULAR.test(s.style)) || f.styles.find((s) => !/italic|oblique/i.test(s.style)) || f.styles[0]; }

/* ------------------------------------------------------------ font faces */

const faceCache = new Map();   // "path#index#mtime" -> alias
let aliasSeq = 0;

/** Registers a FontFace for a style (lazily, when its card scrolls into view); returns the CSS alias. */
function ensureFace(s) {
  const file = s.files.find((x) => x.index === 0) || s.files[0];
  const key = `${file.path}#${file.index}#${file.mtime}`;
  let alias = faceCache.get(key);
  if (alias) return alias;
  alias = `typo-${++aliasSeq}`;
  faceCache.set(key, alias);
  // Faces after the first in a .ttc can't be picked by URL; installed ones resolve by name instead.
  const src = file.index === 0
    ? `url("${fileUrl(file.path)}?v=${file.mtime}")`
    : `local("${(s.ps || '').replace(/"/g, '')}"), local("${(s.full || '').replace(/"/g, '')}")`;
  const face = new FontFace(alias, src);
  document.fonts.add(face);
  face.load().catch(() => {});
  return alias;
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
    const auto = fonts.has(fam) ? autoCat(fam) : null;
    const e = clean(fam, { title: x.title, tags: x.tags, hidden: x.hidden, category: x.category !== auto ? x.category : undefined });
    if (e) meta[fam] = e; else delete meta[fam];
  }
  persistMeta(!fromFile);
  for (const f of fonts.values()) f.refresh?.();
  resort(); renderSidebar(); renderTagList(); applyFilter();
  return Object.keys(parsed).length;
}

/* --------------------------------------- linked .md file: live, two-way sync */

let lastText = null, lastMod = 0, writing = false, writeTimer = 0, linkOk = false;

async function readLinked(force = false) {
  const mt = await invoke('file_mtime', { path: settings.linked });
  if (mt == null) throw new Error('file not found');
  if (!force && mt === lastMod) return false;
  const { text, mtime } = await invoke('read_text', { path: settings.linked });
  lastMod = mtime;
  if (!force && text === lastText) return false;
  lastText = text;
  importMarkdown(text, 'replace', true);
  return true;
}

async function linkFile(existing) {
  const path = existing
    ? await T.dialog.open({ filters: MD_FILTER, title: 'Link an existing taxonomy file' })
    : await T.dialog.save({ defaultPath: 'font-tags.md', filters: MD_FILTER, title: 'Create a linked taxonomy file' });
  if (!path) return;
  settings.linked = path; saveSettings();
  lastText = null; lastMod = 0; linkOk = true;
  try { if (existing) await readLinked(true); await writeLinked(); }
  catch (e) { linkOk = false; status(`Couldn't use ${fileName(path)}: ${e}`); }
  renderLink();
}

async function pollLinked() {
  if (!settings.linked || !settings.watch || writing || document.hidden) return;
  try {
    if (await readLinked()) { renderLink(`reloaded ${new Date().toLocaleTimeString()}`); status('Linked .md changed on disk — reloaded.'); }
    if (!linkOk) { linkOk = true; renderLink(); }
  } catch (e) { if (linkOk) { linkOk = false; renderLink(); status(`Can't read ${fileName(settings.linked)}: ${e.message || e}`); } }
}

function scheduleLinkedWrite() {
  if (!settings.linked || !linkOk) return;
  clearTimeout(writeTimer);
  writeTimer = setTimeout(writeLinked, 600);
}
async function writeLinked() {
  if (!settings.linked) return;
  const text = exportMarkdown();
  if (text === lastText) return;
  writing = true;
  try {
    lastMod = await invoke('write_text', { path: settings.linked, text });
    lastText = text;
    renderLink(`saved ${new Date().toLocaleTimeString()}`);
  } catch (e) { linkOk = false; renderLink(); status(`Couldn't write ${fileName(settings.linked)}: ${e}`); }
  writing = false;
}

function renderLink(note = '') {
  const s = $('#linkStatus');
  s.replaceChildren();
  if (!settings.linked) return;
  const unl = el('button', { className: 'link', textContent: 'unlink', onclick: () => { settings.linked = null; saveSettings(); renderLink(); } });
  const name = el('button', { className: 'link', textContent: fileName(settings.linked), title: settings.linked, onclick: () => invoke('reveal', { path: settings.linked }) });
  s.append(linkOk ? 'Synced with ' : 'Linked (unreachable): ', name, note ? ` · ${note}` : '', ' · ', unl);
}

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
  sel.replaceChildren(el('option', { value: '', textContent: `Auto · ${autoCat(f.family)}` }), ...CATS.map((c) => el('option', { value: c, textContent: c })));
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

const sourcesOf = (f) => uniq(f.styles.flatMap((s) => s.files.map((x) => x.source)));
function sourceLabel(f) {
  const n = f.styles.length;
  const src = sourcesOf(f).map((s) => ({ windows: 'Windows', user: 'installed by you', folder: 'folder', file: 'file' })[s]);
  return `${n} style${n > 1 ? 's' : ''} · ${src.join(' + ')}`;
}

function buildCard(f) {
  const nameEl = el('button', { className: 'name', title: 'Show details' });
  const metaEl = el('span', { className: 'meta', title: 'Show details' });
  const hideBtn = el('button', { className: 'icon' });
  const rmBtn = el('button', { className: 'icon', textContent: '✕', title: 'Remove the added font files from Typo (files stay on disk)' });
  const sel = el('select', { className: 'cat', title: 'Classification' });
  const sample = el('div', { className: 'sample', textContent: ui.text });
  const tagIn = el('input', { className: 'tag-in', placeholder: '+ tag', spellcheck: false });
  tagIn.setAttribute('list', 'tagList');
  const card = el('article', { className: 'card' },
    el('header', {}, nameEl, metaEl, sel, hideBtn, rmBtn),
    sample,
    el('div', { className: 'tags' }, tagIn));
  card.dataset.family = f.family;

  // Handlers look up the current font object, since a rescan replaces it.
  let cur = f;
  nameEl.onclick = metaEl.onclick = () => toggleDetails(cur);
  sel.onchange = () => { setMeta(cur.family, { category: sel.value || undefined }); syncCat(cur); renderSidebar(); applyFilter(); };
  hideBtn.onclick = () => { setMeta(cur.family, { hidden: !m(cur.family).hidden }); cur.refresh(); renderSidebar(); applyFilter(); };
  rmBtn.onclick = () => {
    const mine = new Set(cur.styles.flatMap((s) => s.files.filter((x) => x.source === 'file').map((x) => x.path)));
    settings.files = settings.files.filter((p) => !mine.has(p)); saveSettings(); rescan();
  };

  const commit = () => {
    const add = tagIn.value.split(/[,\s]+/).map(normTag).filter(Boolean);
    tagIn.value = '';
    if (!add.length) return;
    setMeta(cur.family, { tags: uniq([...m(cur.family).tags, ...add]) });
    renderTags(cur); renderSidebar(); renderTagList();
  };
  tagIn.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
    else if (e.key === 'Backspace' && !tagIn.value) {
      const t = m(cur.family).tags; if (t.length) { setMeta(cur.family, { tags: t.slice(0, -1) }); renderTags(cur); renderSidebar(); }
    } else if (e.key === 'Escape') { tagIn.value = ''; tagIn.blur(); }
  };
  tagIn.onblur = commit;

  /** Re-syncs everything on the card from state (after imports, edits, rescans). */
  const refresh = () => {
    const x = m(cur.family);
    nameEl.textContent = title(cur);
    nameEl.classList.toggle('renamed', !!x.title);
    nameEl.title = x.title ? `${cur.family} — click for details` : 'Click for details';
    metaEl.textContent = sourceLabel(cur);
    hideBtn.textContent = x.hidden ? 'unhide' : 'hide';
    hideBtn.title = x.hidden ? 'Show in workspace' : 'Hide from workspace';
    card.classList.toggle('is-hidden', !!x.hidden);
    rmBtn.hidden = !sourcesOf(cur).includes('file');
    syncCat(cur);
    renderTags(cur);
    const d = card.querySelector('.details');
    if (d && !d.contains(document.activeElement)) { d.remove(); toggleDetails(cur); }
  };
  const rebind = (nf) => {
    cur = nf; nf.card = card; nf.refresh = refresh; nf.rebind = rebind;
    if (sample.style.fontFamily) sample.style.fontFamily = `"${ensureFace(rep(nf))}", sans-serif`;
    refresh();
  };
  rebind(f);
  io.observe(card);
  return card;
}

/* ------------------------------------------------------- details & editing */

async function runEdits(label, jobs) {
  status(`${label}…`);
  const notes = [];
  for (const job of jobs) {
    try { notes.push(...(await job())); }
    catch (e) { status(`${label} failed: ${e}`); alert(String(e)); return false; }
  }
  await rescan();
  status(`${label} — done.${notes.length ? ' ' + uniq(notes).join(' ') : ''}`);
  return true;
}

/** After a file edit moves a font to a new family name, carry its tags/label/etc. along. */
function migrateMeta(oldFamily, path) {
  if (!meta[oldFamily] || fonts.has(oldFamily)) return;
  const nf = [...fonts.values()].find((f) => f.styles.some((s) => s.files.some((x) => x.path === path)));
  if (!nf || nf.family === oldFamily) return;
  const a = meta[oldFamily], b = m(nf.family);
  meta[nf.family] = clean(nf.family, { ...a, ...b, tags: uniq([...(b.tags || []), ...a.tags]) }) || undefined;
  if (!meta[nf.family]) delete meta[nf.family];
  delete meta[oldFamily];
  persistMeta();
  nf.refresh?.(); resort(); renderSidebar(); applyFilter();
}

function fileEditor(f, s, file) {
  const where = { windows: 'installed for all users', user: 'installed by you', folder: 'in a folder', file: 'added file' }[file.source];
  const inputs = {
    file: el('input', { type: 'text', value: fileName(file.path), spellcheck: false }),
    1: el('input', { type: 'text', value: s.app || '', spellcheck: false }),
    4: el('input', { type: 'text', value: s.full || '', spellcheck: false }),
    6: el('input', { type: 'text', value: s.ps || '', spellcheck: false }),
  };
  const editable = file.editable;
  if (!editable) for (const k of ['1', '4', '6']) inputs[k].disabled = true;
  const saveBtn = el('button', { textContent: 'Save to file', className: 'primary-sm' });
  const field = (label, input, hint) => el('label', { className: 'frow' }, el('span', { textContent: label, title: hint }), input);
  const box = el('details', { className: 'fedit' },
    el('summary', {}, el('b', { textContent: s.style }), ' — ', fileName(file.path), file.index ? ` (face ${file.index + 1})` : '', el('span', { className: 'muted', textContent: ` · ${where}` })),
    field('File name', inputs.file, 'Name of the file on disk'),
    field('In apps', inputs[1], 'Family name Word, GIMP etc. show (name ID 1)'),
    field('Full name', inputs[4], 'Full font name (name ID 4); also the name Windows lists'),
    field('PostScript', inputs[6], 'PostScript name (name ID 6): no spaces'),
    !editable ? el('p', { className: 'muted small', textContent: 'Web fonts (WOFF/WOFF2) can only be renamed on disk, not edited inside.' }) : null,
    file.source === 'windows' ? el('p', { className: 'muted small', textContent: 'Fonts in C:\\Windows\\Fonts can only be changed when Typo runs as administrator.' }) : null,
    el('p', { className: 'btn-row' }, saveBtn,
      el('button', { textContent: 'Show in Explorer', onclick: () => invoke('reveal', { path: file.path }) })),
  );
  saveBtn.onclick = async () => {
    const set = {};
    if (editable) for (const k of ['1', '4', '6']) if (inputs[k].value.trim() !== ((k === '1' ? s.app : k === '4' ? s.full : s.ps) || '')) set[k] = inputs[k].value.trim();
    const newName = inputs.file.value.trim();
    const renaming = newName && newName !== fileName(file.path);
    if (!Object.keys(set).length && !renaming) { status('Nothing changed.'); return; }
    let path = file.path;
    const jobs = [];
    if (Object.keys(set).length) jobs.push(() => invoke('edit_names', { path, index: file.index, edit: { set } }));
    if (renaming) jobs.push(async () => {
      const r = await invoke('rename_file', { path, newName });
      settings.files = settings.files.map((p) => (p === path ? r.path : p)); saveSettings();
      path = r.path;
      return r.notes;
    });
    if (await runEdits('Saving font file', jobs)) migrateMeta(f.family, path);
  };
  return box;
}

/** Expandable details: Typo label, real names (editable in the files), other-language names, files, styles. */
function toggleDetails(f) {
  const existing = f.card.querySelector('.details');
  if (existing) { existing.remove(); return; }

  const row = (label, ...content) => el('div', { className: 'row' }, el('span', { className: 'k', textContent: label }), el('div', { className: 'v' }, ...content));
  const titleIn = el('input', { className: 'title-in', type: 'text', value: m(f.family).title || '', placeholder: f.family, spellcheck: false });
  titleIn.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); titleIn.blur(); }
    else if (e.key === 'Escape') { titleIn.value = m(f.family).title || ''; titleIn.blur(); }
  };
  titleIn.onblur = () => {
    if ((m(f.family).title || '') === titleIn.value.trim()) return;
    setMeta(f.family, { title: titleIn.value });
    f.refresh(); resort(); applyFilter();
  };

  const entries = f.styles.slice().sort(styleOrder).flatMap((s) => s.files.map((file) => [s, file]));
  const editableCount = entries.filter(([, x]) => x.editable).length;
  const famIn = el('input', { type: 'text', value: f.family, spellcheck: false });
  const famBtn = el('button', { textContent: `Rename in ${editableCount} file${editableCount === 1 ? '' : 's'}`, disabled: !editableCount });
  famBtn.onclick = async () => {
    const to = famIn.value.trim();
    if (!to || to === f.family) return;
    const targets = entries.filter(([, x]) => x.editable);
    if (!confirm(`Rename the family "${f.family}" to "${to}" inside ${targets.length} font file(s)?\n\nThis updates the names apps show, the full names and the PostScript names, and removes names in other languages. A backup of each file is kept (Settings → Open backups).`)) return;
    const jobs = targets.map(([, x]) => () => invoke('edit_names', { path: x.path, index: x.index, edit: { renameFamily: [f.family, to] } }));
    if (await runEdits(`Renaming ${f.family}`, jobs)) migrateMeta(f.family, targets[0][1].path);
  };

  const alt = uniq(f.styles.flatMap((s) => s.alt));
  const styles = el('div', { className: 'styles' });
  for (const s of f.styles.slice().sort(styleOrder)) {
    const r = el('div', {}, el('span', { textContent: s.style, title: s.full }), ui.text.slice(0, 60) || ' ');
    r.style.fontFamily = `"${ensureFace(s)}"`;
    styles.append(r);
  }

  const box = el('div', { className: 'details' },
    row('Label', titleIn, el('div', { className: 'muted small', textContent: 'Typo-only label; doesn\u2019t change the font. Empty = family name.' })),
    row('Family', el('div', { className: 'inline' }, famIn, famBtn),
      el('div', { className: 'muted small', textContent: 'Renames the font itself, in every file of this family. Backups are kept.' })),
    alt.length ? row('Other names', alt.join(' · ')) : null,
    row('Files', el('div', { className: 'fedits' }, ...entries.map(([s, x]) => fileEditor(f, s, x)))),
    styles,
  );
  f.card.querySelector('.sample').after(box);
}

function styleOrder(a, b) {
  const w = (s) => { const t = (s.style || '').toLowerCase().replace(/[\s-]/g, '');
    const n = [['thin', 1], ['hairline', 1], ['extralight', 2], ['ultralight', 2], ['light', 3], ['regular', 4], ['book', 4], ['normal', 4], ['medium', 5], ['semibold', 6], ['demibold', 6], ['extrabold', 8], ['ultrabold', 8], ['bold', 7], ['black', 9], ['heavy', 9]]
      .find(([k]) => t.includes(k));
    return (n ? n[1] : 4) * 2 + (/italic|oblique/.test(t) ? 1 : 0); };
  return w(a) - w(b) || (a.style || '').localeCompare(b.style || '');
}

/* ------------------------------------------------------------ filtering */

/** All the names a font can be found by: your label, family, app names, other-language names, file names. */
function haystack(f) {
  return [title(f), f.family, ...f.styles.flatMap((s) => [s.app, s.full, s.ps, ...s.alt, ...s.files.map((x) => x.path)])].join('\n').toLowerCase();
}

function visible(f) {
  const x = m(f.family);
  if (x.hidden && !ui.showHidden) return false;
  if (filter.q && !haystack(f).includes(filter.q)) return false;
  if (filter.cats.size && !filter.cats.has(category(f.family))) return false;
  if (filter.sources.size && !sourcesOf(f).some((s) => filter.sources.has(s))) return false;
  for (const t of filter.tags) if (t === '∅' ? x.tags.length : !x.tags.includes(t)) return false;
  return true;
}

let sorted = [];
const resort = () => { sorted = [...fonts.values()].sort((a, b) => title(a).localeCompare(title(b), undefined, { sensitivity: 'base' })); };

function rebuild() {
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
  $('#count').textContent = fonts.size ? `${n} of ${fonts.size} families` : '';
}

function chip(label, count, on, onclick) {
  const c = el('button', { className: 'chip' + (on ? ' on' : '') }, label, el('span', { className: 'n', textContent: count }));
  c.onclick = onclick;
  return c;
}
const toggler = (set, v) => () => { set.has(v) ? set.delete(v) : set.add(v); renderSidebar(); applyFilter(); };

function renderSidebar() {
  const pool = [...fonts.values()].filter((f) => ui.showHidden || !m(f.family).hidden);
  const catN = Object.fromEntries(CATS.map((c) => [c, 0]));
  for (const f of pool) catN[category(f.family)]++;
  $('#cats').replaceChildren(...CATS.map((c) => chip(c, catN[c], filter.cats.has(c), toggler(filter.cats, c))));

  const srcN = {};
  for (const f of pool) for (const s of sourcesOf(f)) srcN[s] = (srcN[s] || 0) + 1;
  $('#sources').replaceChildren(...Object.keys(SOURCES).filter((s) => srcN[s] || filter.sources.has(s))
    .map((s) => chip(SOURCES[s], srcN[s] || 0, filter.sources.has(s), toggler(filter.sources, s))));

  const tagN = {};
  for (const x of Object.values(meta)) if (!x.hidden || ui.showHidden) for (const t of x.tags) tagN[t] = (tagN[t] || 0) + 1;
  for (const t of filter.tags) if (t !== '∅') tagN[t] ??= 0;
  const untagged = pool.filter((f) => !m(f.family).tags.length).length;
  $('#tags').replaceChildren(
    ...Object.keys(tagN).sort().map((t) => chip('#' + t, tagN[t], filter.tags.has(t), toggler(filter.tags, t))),
    chip('untagged', untagged, filter.tags.has('∅'), toggler(filter.tags, '∅')));
  $('#clearTags').hidden = !filter.tags.size && !filter.cats.size && !filter.sources.size;

  const hid = [...fonts.keys()].filter((f) => m(f).hidden).length;
  $('#hiddenCount').textContent = hid ? `(${hid})` : '';
}

function renderTagList() {
  const all = new Set(Object.values(meta).flatMap((x) => x.tags));
  $('#tagList').replaceChildren(...[...all].sort().map((t) => el('option', { value: t })));
}

function status(s) { $('#status').textContent = s; }

/* ---------------------------------------------------------------- folders */

async function addFolderPath(p) {
  p = (p || '').trim().replace(/^"|"$/g, '').replace(/[\\/]+$/, '');
  if (!p) return;
  if (!(await invoke('is_dir', { path: p }))) { alert(`Folder not found:\n${p}`); return; }
  if (settings.folders.some((f) => f.toLowerCase() === p.toLowerCase())) { status('That folder is already added.'); return; }
  settings.folders.push(p); saveSettings();
  renderFolders();
  await rescan();
}
async function browseFolder() {
  const p = await T.dialog.open({ directory: true, title: 'Add a font folder' });
  if (p) await addFolderPath(p);
}

function renderFolders() {
  $('#folderList').replaceChildren(...settings.folders.map((p) => el('li', {},
    el('span', { className: 'fname', textContent: p, title: p }),
    el('button', { textContent: 'Open', onclick: () => invoke('reveal', { path: p }) }),
    el('button', { textContent: 'Remove', onclick: () => { settings.folders = settings.folders.filter((x) => x !== p); saveSettings(); renderFolders(); rescan(); } }))));
  if (!settings.folders.length) $('#folderList').append(el('li', { className: 'muted small', textContent: 'No folders yet.' }));
  $('#folderStatus').textContent = settings.folders.length ? `${settings.folders.length} folder${settings.folders.length > 1 ? 's' : ''}` : '';
  const errs = $('#scanErrors');
  errs.replaceChildren(...lastErrors.slice(0, 20).map((e) => el('li', { textContent: e })));
  errs.hidden = !lastErrors.length;
}

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
$('#clearTags').onclick = () => { filter.tags.clear(); filter.cats.clear(); filter.sources.clear(); renderSidebar(); applyFilter(); };

$('#addFolder').onclick = $('#emptyFolder').onclick = browseFolder;
$('#rescan').onclick = () => rescan();
$('#addFiles').onclick = async () => {
  const picked = await T.dialog.open({ multiple: true, title: 'Add font files', filters: [{ name: 'Fonts', extensions: FONT_EXT }] });
  if (picked?.length) addPaths([].concat(picked));
};
$('#exportMd').onclick = async () => {
  const path = await T.dialog.save({ defaultPath: 'font-tags.md', filters: MD_FILTER, title: 'Export taxonomy' });
  if (!path) return;
  try { await invoke('write_text', { path, text: exportMarkdown() }); status(`Exported to ${fileName(path)}.`); }
  catch (e) { status(`Export failed: ${e}`); }
};
$('#importMd').onclick = async () => {
  const path = await T.dialog.open({ filters: MD_FILTER, title: 'Import taxonomy (one-time copy)' });
  if (!path) return;
  try { const { text } = await invoke('read_text', { path }); status(`Imported ${importMarkdown(text, 'merge')} entries (one-time copy — use Link for live sync).`); }
  catch (e) { status(`Import failed: ${e}`); }
};
$('#linkMd').onclick = () => linkFile(true);
$('#newMd').onclick = () => linkFile(false);

// Settings dialog
$('#openSettings').onclick = () => { renderFolders(); $('#settings').showModal(); };
$('#setInstalled').checked = settings.installed;
$('#setWatch').checked = settings.watch;
$(settings.exportAll ? '#scopeAll' : '#scopeAnn').checked = true;
$('#setInstalled').onchange = (e) => { settings.installed = e.target.checked; saveSettings(); rescan(); };
$('#setWatch').onchange = (e) => { settings.watch = e.target.checked; saveSettings(); };
for (const r of document.querySelectorAll('input[name=scope]')) r.onchange = () => {
  settings.exportAll = $('#scopeAll').checked; saveSettings(); scheduleLinkedWrite();
};
$('#folderPath').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#folderAdd').click(); } };
$('#folderAdd').onclick = async () => { await addFolderPath($('#folderPath').value); $('#folderPath').value = ''; };
$('#folderBrowse').onclick = browseFolder;
$('#openBackups').onclick = () => invoke('open_backups');
$('#rescan2').onclick = () => rescan();
$('#resetMeta').onclick = () => {
  if (!confirm('Clear every label, tag, classification override and hidden flag? A linked .md file will be emptied too.')) return;
  meta = {}; persistMeta();
  for (const f of fonts.values()) f.refresh?.();
  rebuild();
};

document.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  if (e.key === '/' && !typing) { e.preventDefault(); $('#search').focus(); }
  else if (e.key === 'Escape' && document.activeElement === $('#search')) { $('#search').value = ''; filter.q = ''; applyFilter(); $('#search').blur(); }
  else if ((e.key === 'F5' || (e.ctrlKey && e.key === 'r')) && !typing) { e.preventDefault(); rescan(); }
});

/** Dropped / picked paths: fonts become added files, folders become font folders, .md is imported. */
async function addPaths(paths) {
  let changed = false;
  for (const p of paths) {
    const ext = (p.split('.').pop() || '').toLowerCase();
    if (['md', 'markdown'].includes(ext)) {
      try { const { text } = await invoke('read_text', { path: p }); status(`Imported ${importMarkdown(text, 'merge')} entries from ${fileName(p)}.`); }
      catch (e) { status(`Import failed: ${e}`); }
    } else if (FONT_EXT.includes(ext)) {
      if (!settings.files.includes(p)) { settings.files.push(p); changed = true; }
    } else if (await invoke('is_dir', { path: p })) {
      if (!settings.folders.includes(p)) { settings.folders.push(p); changed = true; }
    }
  }
  if (changed) { saveSettings(); renderFolders(); await rescan(); }
}

T.webview.getCurrentWebview().onDragDropEvent((e) => {
  const t = e.payload.type;
  if (t === 'enter' || t === 'over') $('#drop').classList.add('on');
  else $('#drop').classList.remove('on');
  if (t === 'drop') addPaths(e.payload.paths || []);
});

/* -------------------------------------------------------------------- boot */

(async function boot() {
  applyUI();
  renderFolders();
  // A linked .md file is the source of truth: read it before anything can write to it.
  if (settings.linked) {
    try { linkOk = true; await readLinked(true); } catch (e) { linkOk = false; status(`Linked file unavailable: ${e.message || e}`); }
  }
  renderLink();
  await rescan();
})();
