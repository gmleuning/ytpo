# Typo

A minimal, local-first font browser designed for rapid visual inspection, custom taxonomic tagging, and plaintext configuration portability.

Built to strip away bloated font-management suites, this tool focuses on a fast, distraction-free workflow: previewing local typefaces with live custom text, filtering by typographic classification and user-defined tags, hiding unused system clutter, and storing all metadata in human-readable Markdown.

No build step, no dependencies, no server-side anything — three static files (`index.html`, `style.css`, `app.js`).

---

## Running it

Open `index.html` in a Chromium browser (Chrome, Edge, Brave, Arc). Or serve the folder locally:

```bash
python -m http.server 5173
```

then visit <http://localhost:5173>.

There are three ways to get fonts in:

* **Add font folder…** (recommended for your own collection): pick a folder, and every font file in it and its subfolders is shown, with file names. Nothing is copied or moved. Folders are remembered; if the browser asks for access again after a restart, click *reconnect* under the button. Manage folders in **Settings**.
* **Load system fonts**: allow the *Local fonts* permission when asked. Typo then reloads them on every visit (switch this off in Settings). The browser doesn't expose file names for installed fonts, so add their folder too if you want those.
* **Add font files…** or drop `.ttf` / `.otf` / `.woff` / `.woff2` / `.ttc` files anywhere on the page. These are kept in the browser's storage until you remove them (✕ on the card).

The same font found in several places (installed *and* in a folder, or duplicated across folders) shows up once, with all its files listed.

> Firefox and Safari don't support the Local Font Access API, so they can only show dropped font files. Linking a `.md` file also needs Chromium; Export and Import work everywhere.

---

## Core Features

* **Live Specimen Preview:** Inspect installed system fonts and local font files (`.ttf`, `.otf`, `.woff`, `.woff2`) in a clean, scrollable grid or list view.
* **Font details & custom titles:** Click a font's name to expand its details: an editable **Title** (your own name for it, shown on the card and used for sorting, marked with ✎), the real family name, the name apps such as Word and GIMP list in their font menus, names in other languages (e.g. the Hangul name of a Korean font), every file it comes from, the PostScript name, and every weight and style. Search matches all of these, so you can type a file name, an English name or a Hangul name. Fonts whose internal name is junk (like `.`) fall back to their file name.
* **Interactive Type Tester:** A persistent global text input bar to test custom strings, pangrams, or character sets across all visible typefaces simultaneously, with adjustable font size and tracking. A preset menu has pangrams, alphabets, numerals, punctuation, and Korean and Japanese samples.
* **Classification & Tag Filtering:**
  * Filter by primary typographic classifications (**Serif**, **Sans-Serif**, **Monospace**, **Display**, **Script/Handwriting**, **CJK**). Classifications are detected from each font's own tables (CJK code pages and Unicode ranges, OS/2 family class, PANOSE, `post.isFixedPitch`), falling back to name heuristics, and can be overridden per font from the card's dropdown.
  * Filter by custom, user-assigned tags (e.g., `#editorial`, `#brutalist`, `#ui`, `#korean-support`). Selected tags combine with AND; an *untagged* chip finds fonts you haven't sorted yet.
* **On-the-Fly Tagging:** Type into the `+ tag` field on any card. Enter, comma or space adds tags (with autocomplete from existing tags), Backspace on an empty field removes the last one, × removes a specific tag, and clicking a tag filters by it.
* **Declutter / Hide Mode:** Mark rarely used, legacy, or OS-locked system fonts as hidden to keep the active workspace focused, with a single toggle to reveal hidden fonts when needed.
* **Markdown Portability (`.md`):** Export your entire tagging taxonomy, hidden font list, and classification overrides into a clean Markdown file, and import it back on any machine or version-control it in an Obsidian vault or Git repository.
  * **Export .md** downloads `font-tags.md`.
  * **Import .md…** (or dropping a `.md` file) is a **one-time copy**: it merges the file in (entries in the file win), but later edits to that file are not picked up.
  * **Link existing .md…** / **Link new .md…** keep a file (for example, one inside your vault) in **live, two-way sync**. Changes in Typo are written to the file within a second. Edits made to the file elsewhere (Obsidian, a text editor, a `git pull`) are picked up automatically within about two seconds, or as soon as you switch back to Typo. While linked, the file is the source of truth: it's read first on every start. After a browser restart, click *reconnect* if the browser asks for access again.
  * By default every loaded font is exported; Settings can limit it to fonts you've annotated.

Keyboard: `/` focuses search, `Esc` clears it.

**Settings** (top right) holds font folders, the system-fonts-on-startup switch, export scope, the live-reload switch for a linked `.md`, and data resets.

---

## Markdown Schema (`.md` Import / Export)

Configuration and tag states are serialized into a structured, human-editable Markdown format so your font library metadata is never locked into a proprietary database.

Every loaded font is written (or only annotated ones, if you choose that in Settings). Entries for fonts that aren't on the current machine are kept, so the file round-trips safely between machines.

Each `###` heading is the font's real family name and is the key, so don't rename headings. To rename a font, set its **Title**. Fields:

| Field | Meaning |
|---|---|
| `Title` | Your display name (optional; omitted when not set) |
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
- **Files:** MyFonts/NotoSerifKR-Regular.otf

## Hidden Fonts

### Arial Unicode MS
- **Category:** Sans-Serif
- **Tags:** #legacy
- **Status:** hidden
```

Font headings (`###`) use the font's family name as reported by the OS or by the font file's `name` table.
