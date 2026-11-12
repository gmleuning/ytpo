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

Click **Load system fonts** and allow the *Local fonts* permission when the browser asks. After that, Typo reloads your system fonts automatically on every visit. To add fonts that aren't installed, click **Add font files…** or drop `.ttf` / `.otf` / `.woff` / `.woff2` / `.ttc` files anywhere on the page; they're kept in the browser's IndexedDB until you remove them (✕ on the card).

> Firefox and Safari don't support the Local Font Access API, so they can only show dropped font files. Linking a `.md` file also needs Chromium; Export and Import work everywhere.

---

## Core Features

* **Live Specimen Preview:** Inspect installed system fonts and local font files (`.ttf`, `.otf`, `.woff`, `.woff2`) in a clean, scrollable grid or list view. Click a card's "*n* styles" label to expand every weight and style.
* **Interactive Type Tester:** A persistent global text input bar to test custom strings, pangrams, or character sets across all visible typefaces simultaneously, with adjustable font size and tracking. A preset menu has pangrams, alphabets, numerals, punctuation, and Korean and Japanese samples.
* **Classification & Tag Filtering:**
  * Filter by primary typographic classifications (**Serif**, **Sans-Serif**, **Monospace**, **Display**, **Script/Handwriting**). Classifications are detected from each font's own tables (OS/2 family class, PANOSE, `post.isFixedPitch`), falling back to name heuristics, and can be overridden per font from the card's dropdown.
  * Filter by custom, user-assigned tags (e.g., `#editorial`, `#brutalist`, `#ui`, `#korean-support`). Selected tags combine with AND; an *untagged* chip finds fonts you haven't sorted yet.
* **On-the-Fly Tagging:** Type into the `+ tag` field on any card. Enter, comma or space adds tags (with autocomplete from existing tags), Backspace on an empty field removes the last one, × removes a specific tag, and clicking a tag filters by it.
* **Declutter / Hide Mode:** Mark rarely used, legacy, or OS-locked system fonts as hidden to keep the active workspace focused, with a single toggle to reveal hidden fonts when needed.
* **Markdown Portability (`.md`):** Export your entire tagging taxonomy, hidden font list, and classification overrides into a clean Markdown file, and import it back on any machine or version-control it in an Obsidian vault or Git repository.
  * **Export .md** downloads `font-tags.md`.
  * **Import .md…** (or dropping a `.md` file) merges it in; entries in the file win.
  * **Link .md file…** keeps a file (for example, one inside your vault) in sync: every change is written to it automatically. After a browser restart, click *reconnect* to re-grant access; the file is then re-read as the source of truth.

Keyboard: `/` focuses search, `Esc` clears it.

---

## Markdown Schema (`.md` Import / Export)

Configuration and tag states are serialized into a structured, human-editable Markdown format so your font library metadata is never locked into a proprietary database.

Only fonts with metadata (a tag, a classification override, or hidden) are written. Entries for fonts that aren't installed on the current machine are kept, so the file round-trips safely between machines. The parser is lenient: it ignores unknown lines and sections, accepts `sans`/`mono`/`script`-style category spellings, and treats the `Status` line (or, failing that, the `## Hidden Fonts` section) as the visibility.

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
- **Category:** Serif
- **Tags:** #editorial, #multilingual, #body
- **Status:** visible

## Hidden Fonts

### Arial Unicode MS
- **Category:** Sans-Serif
- **Tags:** #legacy
- **Status:** hidden
```

Font headings (`###`) use the font's family name as reported by the OS or by the font file's `name` table.
