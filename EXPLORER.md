# Jek OpenCode Explorer

[![license](https://img.shields.io/github/license/jekverse/jek-opencode-plugin)](https://github.com/jekverse/jek-opencode-plugin/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/jekverse/jek-opencode-plugin?style=flat)](https://github.com/jekverse/jek-opencode-plugin/stargazers)

A full-featured workspace and file editor panel for **OpenCode Desktop**. Files open in their own tabs, edits autosave, media files preview natively, and workspace tree shortcuts keep file management frictionless.

Built on the `@opencode/plugin/gui` SDK, seamlessly integrating with OpenCode's buttons, fields, tooltips, themes, and Markdown renderer.

The plugin targets **OpenCode Desktop 2.2.5 or newer** and uses its experimental GUI SDK. See [Status](#status) for verification and release details.

## Why use it?

OpenCode's built-in file viewer is useful for inspecting files during a chat. Workspace adds a place to make manual edits, browse project files, and preview media without leaving the session. The workspace tree sits to the right of the file content, with the AI chat on the left.

The editor keeps a draft while you switch tabs. If an agent or another editor changes the file on disk, the next save detects the conflict and asks whether to reload the disk copy or explicitly overwrite it.

## Upstream preview

These screenshots show the original project's browsing, quick open, and table features.

<img src="https://raw.githubusercontent.com/cheejiayuan512/opencode-file-editor/main/docs/demo.gif" alt="Switching between the CSV table view, quick open, the source editor, the Markdown preview and the folder browser" width="880">

<img src="https://raw.githubusercontent.com/cheejiayuan512/opencode-file-editor/main/docs/quick-open.png" alt="Quick open filtered to gui, in the panel's workspace tree" width="880">

<img src="https://raw.githubusercontent.com/cheejiayuan512/opencode-file-editor/main/docs/table-view.png" alt="A CSV opened in the table view, with the workspace tree beside it" width="880">

## Features

- **Workspace Tree & Keyboard Shortcuts**:
  - Click or right-click to select any file or directory in the tree.
  - Press **`F2`** to immediately rename the selected item.
  - Press **`Delete`** to trigger confirmation and delete the selected item.
  - Collapsible sidebar loaded folder by folder with ignored files muted.
- **Media Previews**:
  - **Images** (`.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.svg`, etc.): Full preview with mouse wheel zoom and left-click pan/drag.
  - **Audio** (`.mp3`, `.wav`, `.ogg`, `.flac`, `.m4a`, etc.): Native playback controls directly inside tabs.
  - **Video** (`.mp4`, `.webm`, `.mov`, etc.): Clean native video controls without external dependencies.
- **Tabs** — one per file, restored per session. `●` marks unsaved changes.
- **Autosave** with `Ctrl/Cmd+S`, undo/redo, and drafts that survive tab switches.
- **Conflict guard** — if a file changes on disk while open, autosave halts and prompts **Reload** or **Overwrite**.
- **Atomic writes** — temporary file then rename, preventing crash truncation.
- **Byte-faithful** — CRLF and UTF-8 BOM are preserved.
- **Markdown preview** rendered by OpenCode's timeline renderer with a Source toggle.
- **CSV/TSV table view** with row numbers and zebra striping (RFC 4180 quoted fields).
- **Line numbers** that follow word wrap, plus wrap and auto-save toggles.
- **Folder browser** — click any breadcrumb segment to browse, with folders and files color-coded.
- **Create files and folders** from the workspace tree header.
- **Drag & drop files from the desktop** onto the panel or tree folder to copy into the workspace.
- **Right-click file actions** — cut, copy, paste into folder, rename, and delete.
- **Quick open** — type in the filter for fuzzy path searching; `Up`/`Down` navigates and `Enter` opens.
- **Recent files** on the **Open file** tab.
- **Reveal in file manager** and **copy relative path**.

## Install

```sh
opencode plugin add https://github.com/jekverse/jek-opencode-plugin
```

Or add it to your global config so every window has it:

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugins": ["https://github.com/jekverse/jek-opencode-plugin"]
}
```

Restart OpenCode Desktop, then open the panel with `Ctrl+Shift+E` (`Cmd+Shift+E` on macOS), `/workspace`, or **+ → Workspace** in the session panel.

## Use

- **Open a file** — click a file path in chat, type one in the panel (`src/App.tsx`, `C:\...`, `~/notes.md`), or pick from **Recent** / **Browse files**.
- **Find a file** — expand the tree in the sidebar, or type in its filter to quick-open any path in the workspace.
- **Navigate** — breadcrumb segments are buttons; each opens the folder.
- **Save** — autosave after a pause; `Ctrl/Cmd+S` saves immediately. **Reload** re-reads from disk.
- **Markdown** — `.md`, `.markdown`, `.mdx` open rendered; toggle to source.
- **Tables** — `.csv`, `.tsv` open as a table; first 500 rows, then a note.

## Limits

- Text editing supports UTF-8 files up to 2 MiB. The editor reports unreadable or unsupported files.
- Media previews load up to 64 MiB per file. Playback depends on the format and codecs supported by OpenCode Desktop.
- Drag-and-drop imports accept up to 32 MiB per file. Directory listings cap at 2,000 entries and display the real total.
- Workspace filesystem operations run on the local machine. Dropping files on chat uses OpenCode's attachment workflow.

## Shortcuts

| Shortcut | Where | Action |
| --- | --- | --- |
| `Ctrl+Shift+E` / `Cmd+Shift+E` | OpenCode session | Toggle Workspace |
| `/workspace` | Chat composer | Open or toggle Workspace |
| `Ctrl+S` / `Cmd+S` | Text editor | Save immediately |
| `Ctrl+Z` / `Cmd+Z` | Text editor | Undo |
| `Ctrl+Shift+Z` / `Cmd+Shift+Z` or `Ctrl+Y` | Text editor | Redo |
| `Alt+Z` (upcoming) | Text editor | Toggle Word Wrap. Wrapping changes the display only |
| `↑` / `↓`, then `Enter` | Quick open | Move through results and open the selected file |
| `F2` | Selected tree item | Open Rename |
| `Delete` | Selected tree item | Ask for confirmation before deleting |
| `Shift+Alt+C` | Selected tree item | Copy its full path |
| `Esc` | Tree menu or desktop drop overlay | Dismiss the menu or clear the overlay |

In image previews, use `Ctrl`/`Cmd` + scroll to zoom around the pointer, `Shift` + scroll to pan horizontally, and regular scroll to pan vertically. Double-click the image or click the zoom badge to reset.

## Status

- The package manifest currently identifies version **0.2.5**. See the [changelog](CHANGELOG.md) for repository history.
- The next editor update adds CodeMirror highlighting for TypeScript, JavaScript, JSX, TSX, Python, JSON, HTML, CSS and Markdown source. Syntax colors follow the Desktop theme. Other supported UTF-8 files remain editable as plain text.
- The same update adds `Alt+Z` and expands chat link handling to supported local text, image, audio and video paths. OpenCode still owns attachment previews that it opens directly. External URLs, PDF and archive links follow the host's routing.
- Type checking and the 138-test suite passed on the development build with these changes. Live verification of that build is pending because the OpenCode Desktop service could not be reached. The minimum SDK version is a target, and newer Desktop releases may need compatibility checks.

## Development

Use Node.js 20 or newer. From a local checkout, run:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run verify:live -- --strict
```

`npm test` builds the GUI and runs the regression suite. The build produces `gui-experimental.cjs` at the repository root. For live verification, configure OpenCode Desktop to load the local checkout, restart the app, and run the strict check while Desktop is running. The check verifies that the host loaded the current bundle. Use the Desktop UI to check rendering, keyboard shortcuts, and attachment behavior.

## Acknowledgments & Credits

The Explorer plugin is an enhanced fork of the original [opencode-file-editor](https://github.com/cheejiayuan512/opencode-file-editor) created by **[JIAYUAN (cheejiayuan512)](https://github.com/cheejiayuan512)**.

All respect and gratitude go to JIAYUAN for architecting and building the rock-solid foundation of this plugin. This fork extends the project with:
- Tree rail keyboard shortcuts (`F2` to rename, `Delete` to delete).
- Native media preview support (images with interactive zoom/pan, audio, and video).
- Workspace branding and usability enhancements.

## License

[MIT](LICENSE) © 2026 JIAYUAN & Jekverse
