# Typo

A minimal, local-first font browser designed for rapid visual inspection, custom taxonomic tagging, and plaintext configuration portability.

Built to strip away bloated font-management suites, this tool focuses on a fast, distraction-free workflow: previewing local typefaces with live custom text, filtering by typographic classification and user-defined tags, hiding unused system clutter, and storing all metadata in human-readable Markdown.

A small Windows desktop app: a Rust backend ([Tauri](https://tauri.app)) that finds, reads and edits font files, around a plain HTML/CSS/JS interface in `ui/`.

---

## Running it

**Use it:** run the installer from `src-tauri/target/release/bundle/nsis/`, or run `src-tauri/target/release/typo.exe` directly.

**Build it** (needs [Rust](https://rustup.rs), Node.js, and the Visual Studio C++ Build Tools):

```bash
npm install
```

```bash
npm run dev
```

```bash
npm run build
```

`npm run dev` opens the app and reloads it when you edit `ui/`. `npm run build` makes the `.exe` and the installer.

### Getting fonts in

* **Installed fonts** are shown automatically, with their real file paths, split by where they live: **Windows (all users)** (`C:\Windows\Fonts`) and **Installed by you** (`%LOCALAPPDATA%\Microsoft\Windows\Fonts`). Turn this off in Settings if you only want your own folders.
* **Font folders:** Settings → type or paste any path (hidden and system folders included), or Browse. Every font in the folder and its subfolders is shown. Nothing is copied, moved or installed.
* **Files:** *Add font files…*, or drop font files or whole folders onto the window.

The same font found in several places shows up once, with every file listed. The **Source** filter in the sidebar separates Windows fonts, fonts you installed, folders and added files. Use **Rescan** (or F5) after adding fonts outside Typo; scans are cached, so they're quick after the first one.

---

## Core Features

* **Live Specimen Preview:** Inspect installed system fonts and local font files (`.ttf`, `.otf`, `.woff`, `.woff2`) in a clean, scrollable grid or list view.
* **Font details:** Click a font's name to expand it. You'll see:
  * a **Label**: a Typo-only name, shown on the card and used for sorting (marked ✎). It doesn't change the font.
  * names in other languages (e.g. the Hangul name of a Korean font)
  * every file the font comes from, and every weight and style

  Search matches all of these, so you can type a file name, an English name or a Hangul name. Fonts whose internal name is junk (like `.`) fall back to their file name.
* **Editing the fonts themselves:** in the same panel:
  * **Family → Rename in N files** renames the whole family inside every file. It updates the name apps show, the full name and the PostScript name, and removes names in other languages so the new name shows everywhere.
  * Each file's block edits its **file name** on disk, the name **in apps** (Word, GIMP; name ID 1), the **full name** (name ID 4) and the **PostScript** name (name ID 6).
  * Every edit copies the original to a backups folder first (Settings → *Open backups folder*), writes the new file safely, keeps checksums valid, and drops the now-invalid digital signature.
  * Installed fonts are re-registered with Windows, including their registry entry. Apps that are already open may need restarting to show a new name.
  * Fonts in `C:\Windows\Fonts` can only be changed when Typo runs as administrator; fonts you installed yourself don't need that.
  * WOFF/WOFF2 web fonts can be renamed on disk but not edited inside.
  * Renaming a font breaks documents that use the old name, and some font licenses (e.g. the OFL's Reserved Font Name clause) restrict changing names.
* **Interactive Type Tester:** A persistent global text input bar to test custom strings, pangrams, or character sets across all visible typefaces simultaneously, with adjustable font size and tracking. A preset menu has pangrams, alphabets, numerals, punctuation, and Korean and Japanese samples.
* **Classification & Tag Filtering:**
  * Filter by primary typographic classifications (**Serif**, **Sans-Serif**, **Monospace**, **Display**, **Script/Handwriting**, **CJK**). Classifications are detected from each font's own tables (CJK code pages and Unicode ranges, OS/2 family class, PANOSE, `post.isFixedPitch`), falling back to name heuristics, and can be overridden per font from the card's dropdown.
  * Filter by custom, user-assigned tags (e.g., `#editorial`, `#brutalist`, `#ui`, `#korean-support`). Selected tags combine with AND; an *untagged* chip finds fonts you haven't sorted yet.
* **On-the-Fly Tagging:** Type into the `+ tag` field on any card. Enter, comma or space adds tags (with autocomplete from existing tags), Backspace on an empty field removes the last one, × removes a specific tag, and clicking a tag filters by it.
* **Declutter / Hide Mode:** Mark rarely used, legacy, or OS-locked system fonts as hidden to keep the active workspace focused, with a single toggle to reveal hidden fonts when needed.
* **Markdown Portability (`.md`):** Export your entire tagging taxonomy, hidden font list, and classification overrides into a clean Markdown file, and import it back on any machine or version-control it in an Obsidian vault or Git repository.
  * **Export .md** saves a `font-tags.md` wherever you choose.
  * **Import .md…** (or dropping a `.md` file) is a **one-time copy**: it merges the file in (entries in the file win), but later edits to that file are not picked up.
  * **Link existing .md…** / **Link new .md…** keep a file (for example, one inside your vault) in **live, two-way sync**. Changes in Typo are written to the file within a second. Edits made to the file elsewhere (Obsidian, a text editor, a `git pull`) are picked up automatically within about two seconds, or as soon as you switch back to Typo. While linked, the file is the source of truth: it's read first on every start.
  * By default every loaded font is exported; Settings can limit it to fonts you've annotated.

Keyboard: `/` focuses search, `Esc` clears it, `F5` rescans.

**Settings** (top right) holds font folders, the installed-fonts switch, export scope, the live-reload switch for a linked `.md`, the backups folder, and data resets.

---

## Markdown Schema (`.md` Import / Export)

Configuration and tag states are serialized into a structured, human-editable Markdown format so your font library metadata is never locked into a proprietary database.

Every loaded font is written (or only annotated ones, if you choose that in Settings). Entries for fonts that aren't on the current machine are kept, so the file round-trips safely between machines.

Each `###` heading is the font's real family name and is the key, so don't rename headings. To give a font a different name, set its **Title** (a Typo-only label); to change the font itself, use *Rename in N files* in the app. Fields:

| Field | Meaning |
|---|---|
| `Title` | Your Typo label (optional; omitted when not set) |
| `Category` | `Serif`, `Sans-Serif`, `Monospace`, `Display`, `Script/Handwriting` or `CJK` |
| `Tags` | `#tag` list |
| `Status` | `visible` or `hidden` |
| `Files` | Where the font was found. Informational: ignored on import |

The parser is lenient: it ignores unknown lines and sections, accepts `sans`/`mono`/`script`/`korean`-style category spellings, and treats the `Status` line (or, failing that, the `## Hidden Fonts` section) as the visibility.

### Example `font-tags.md`

```markdown
---
version: 1.0
exported: 2026-11-11
---

# Font Taxonomy

## Active Fonts

### Inter
- **Category:** Sans-Serif
- **Tags:** #ui, #clean, #variable
- **Status:** visible

### JetBrains Mono
- **Category:** Monospace
- **Tags:** #code, #terminal, #tabular
- **Status:** visible

### Noto Serif KR
- **Title:** Noto Serif (Korean)
- **Category:** CJK
- **Tags:** #editorial, #multilingual, #body
- **Status:** visible
- **Files:** D:\Fonts\Noto\NotoSerifKR-Regular.otf

## Hidden Fonts

### Arial Unicode MS
- **Category:** Sans-Serif
- **Tags:** #legacy
- **Status:** hidden
```

Font headings (`###`) use the font's family name from its `name` table (typographic family, else legacy family).

---

## Project layout

| Path | What |
|---|---|
| `ui/` | The interface: `index.html`, `style.css`, `app.js` |
| `src-tauri/src/sfnt.rs` | Reads and rewrites font binaries (TTF/OTF/TTC/WOFF): names, classification, name-table rebuild |
| `src-tauri/src/scan.rs` | Finds fonts (installed, folders, files) and caches their metadata |
| `src-tauri/src/edit.rs` | Name edits and file renames, with backups (tests: `cargo test` in `src-tauri`) |
| `src-tauri/src/winfonts.rs` | Windows font registry; unloading and reloading installed fonts |
| `src-tauri/src/main.rs` | The commands the UI calls |

Typo's own data (labels, tags, overrides, hidden flags, settings) is kept in the app's local storage and, if you link one, in your Markdown file. The scan cache and backups are in `%APPDATA%\io.github.typo-fonts\`.
