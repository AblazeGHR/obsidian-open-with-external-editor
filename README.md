# Open with External Editor

An [Obsidian](https://obsidian.md) plugin that lets you open any file or folder in a **configurable external editor** (VSCode, Cursor, Sublime Text, …) directly from the file explorer's right-click menu.

When the file is **already open in Obsidian**, the plugin reads the current cursor position and tells the external editor to jump to the **same line and column** — so your place in the document carries over.

## Features

- Right-click any file or folder → **"Open in …"** entries for each configured editor.
- **Cursor sync:** opening a file you're already editing jumps to the same line/column in the external editor (via each editor's goto syntax, e.g. VSCode's `-g path:line:col`).
- Fully **configurable**: add as many editors as you like, each with its own command and argument template. Ships with a VSCode opener by default.
- Command-palette commands to open the currently active file in each configured editor.

> Note: desktop-only. Opening external programs requires the local Node runtime provided by the Obsidian desktop app.

## Installation

### From this repository (manual / BRAT)

1. Download `main.js`, `manifest.json`, `styles.css`, and `versions.json`.
2. Put them in `<your vault>/.obsidian/plugins/open-with-external-editor/`.
3. In Obsidian: Settings → Community plugins → enable **Open with External Editor**.

For development, clone the repo and run `npm install`, then `npm run dev` (watch mode) or `npm run build`.

## Usage

1. Make sure the external editor's command is on your `PATH` (e.g. VSCode's `code`, installed with the *"Add to PATH"* option), or set an absolute path in the settings.
2. Right-click a file or folder in the file explorer and pick your editor.
3. If the file is already open in Obsidian, you'll land on the same line/column in the external editor.

## Configuration

Open **Settings → Open with External Editor**. Each opener has:

- **Menu label** — text shown in the context menu.
- **Command** — the executable/command, e.g. `code` or `C:\Users\you\AppData\Local\Programs\Microsoft VS Code\bin\code.cmd`.
- **Arguments** — one argument per line, using placeholders:
  - `{path}` — absolute path of the file/folder (always available)
  - `{line}` — 1-based cursor line in Obsidian (empty for folders / files not currently open)
  - `{col}` — 1-based cursor column in Obsidian (empty for folders / files not currently open)
- **Hotkey** *(optional)* — a keyboard shortcut that opens the current file with this editor, e.g. `Ctrl+Shift+O`. Use `Mod` for a platform-aware modifier (Ctrl on Windows/Linux, Cmd on macOS); also accepts `Cmd`, `Alt`/`Option`, `Shift`. Separate multiple shortcuts with a comma (e.g. `Ctrl+O, Ctrl+Shift+O`). Leave empty for none. The shortcut can still be changed or overridden in **Settings → Hotkeys**.

A flag that should only appear together with `{line}`/`{col}` (such as VSCode's `-g`) goes on the line **directly above** the token that uses them. The plugin automatically drops both when line/col is unavailable, so folders and closed files still open normally.

### Default VSCode opener

```
Command: code
Args:
  -g
  {path}:{line}:{col}
```

Result:
- File open in Obsidian → `code -g /abs/path:12:5`
- Folder, or file not open → `code /abs/path`

### Examples

**Cursor** (VSCode-compatible `-g`):

```
Command: cursor
Args:
  -g
  {path}:{line}:{col}
```

**Sublime Text** (`subl path:line`):

```
Command: subl
Args:
  {path}:{line}
```

## Development

```bash
npm install
npm run dev      # watch mode, rebuilds main.js on change
npm run build    # type-check + production bundle
```

The plugin is bundled with [esbuild](https://esbuild.github.io/); `main.js` is the compiled output.

## License

MIT
