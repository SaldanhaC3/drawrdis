# Drawrdis

A local-first, hand-drawn-style whiteboard built for a new kind of collaboration: **you draw, your AI agent sees it — and draws back.**

No cloud. No accounts. Zero runtime dependencies. One `node` process.

<p align="center">
  <img src="screenshots/editor.png" alt="Drawrdis editor with a sketched app flow" width="720">
</p>

<p align="center"><em>Sketch app screens, flows and diagrams while your coding agent reads the board as JSON and sketches back in real time.</em></p>

[Leia em português](README.pt-BR.md)

## Why

AI coding agents are great at code and blind at design. Drawrdis gives them eyes and hands: the whole board lives in a plain JSON file the agent reads and writes directly, and an MCP server exposes it as tools. You sketch screens; the agent reviews them, fixes spacing, wires flows with arrows and drafts the next screen while you watch it appear live.

## Features

- Hand-drawn look (three roughness levels, hachure/cross-hatch/solid fills)
- Shapes, freehand, arrows with **curved points**, lines, text, images
- **Arrow binding**: arrow ends snap to shapes and follow them when moved/resized
- **Text containers**: resize the box and the text reflows; Alt-drag scales the font
- Flows: Ctrl+arrows clones the element in a direction and links it with a bound arrow; Ctrl+Enter clones the whole screen/frame
- **Grouping**: Ctrl+G groups the selection so you move and resize many elements as one; Alt+click grabs a single item inside a group
- **Agent presence**: every item records who last edited it (`by`), items the agent writes flash on your screen, and a chip says "the agent edited N items" the moment it happens
- **Navigation links + present mode**: select an element, Ctrl+L, click a destination; Alt+P presents the prototype with click-to-jump (the agent wires the same links with one `update_items`)
- Search (Ctrl+F), object lock (Ctrl+Shift+L), automatic history with one-click restore
- Live collaboration with your agent: SSE push (incremental diffs), file-based board, MCP tools
- **Concurrent-safe writes**: agent and human editing at the same time don't erase each other (per-item merge, field-level patches, a board revision number, and surgical undo that never reverts the agent's work)
- Named projects (save/open multiple boards), portable `.drawrdis` files
- Dark theme, magnetic grid, zen mode, English UI toggle
- Export PNG, SVG and Excalidraw; drag-and-drop import of boards exported from other whiteboard apps
- Images stored as files under `files/` so `board.json` stays light
- 70-test e2e harness that runs headless in CI

<p align="center">
  <img src="screenshots/editor-dark.png" alt="Drawrdis in dark theme" width="720">
</p>

## Quick start

Requires Node 18+.

```sh
node server.js
# opens nothing automatically; visit:
# http://127.0.0.1:3750
```

Or use a launcher (starts the server and opens your browser):

```sh
bin/drawrdis.bat     # Windows
bin/drawrdis.sh      # macOS / Linux
```

Set `DRAWRDIS_PORT` to change the port (it scans the next 10 if busy).
Set `DRAWRDIS_BOARD` to point the server at a different board file.

## Onboarding (first 2 minutes)

1. **Open the board.** Run `node server.js` and visit `http://127.0.0.1:3750`. You get a canvas with three phone frames to start from.
2. **Draw something.** Pick a tool on the left (rectangle, pen, arrow, text) or stamp a widget (phone frame, button, card) from the bottom bar. Drag to move, handles to resize, `[` / `]` to send back / bring forward.
3. **Make a flow.** Select an element and press Ctrl+↑/↓/←/→ to clone it in that direction and link the two with a bound arrow. Ctrl+Enter clones a whole screen. To make the prototype clickable: select an element, press Ctrl+L, click the destination; Alt+P presents.
4. **Bring your agent in.** Connect an AI agent over MCP (next section). Ask it to "look at the board and tidy the spacing" — it reads the JSON, edits items, and you watch the changes land live.
5. **Save.** The board auto-saves to `board.json`. Menu → *Saved boards…* keeps named projects; Menu → *Save .drawrdis file* downloads a portable copy.

## Connect your AI agent (MCP)

Register the MCP server in any MCP client (the config shape below is common across clients):

```json
{
  "mcp": {
    "servers": {
      "drawrdis": {
        "command": "node",
        "args": ["/absolute/path/to/drawrdis/mcp-server.js"]
      }
    }
  }
}
```

The agent gets nine tools:

| tool | what it does |
|---|---|
| `drawrdis_get_scene` | read the board (`summary` or full `json`; includes the `rev`), or with `since=N` only what changed since rev N |
| `drawrdis_add_items` | append shapes/text/arrows (stamped `by:"agent"`, so you see them flash in) |
| `drawrdis_update_items` | field-level patches by id (only the fields it sends change; `null` deletes one) |
| `drawrdis_delete_items` | remove items by id |
| `drawrdis_replace_scene` | wipe and set the whole board (needs the `rev` it read; auto-snapshots first) |
| `drawrdis_wait_for_change` | block until the human edits the board; returns the ids that changed |
| `drawrdis_layout` | align / distribute / place-right / grid, computed server-side (no pixel math by the agent) |
| `drawrdis_user_state` | what the human is seeing right now: selection + viewport |
| `drawrdis_render` | return the board as a PNG, whole or cropped to `ids`/`bbox` for a legible close-up |

Every write is a per-item merge against the current board, so the agent and you can edit at once without clobbering each other: the agent's patch of `{fill}` won't revert a move you made a second earlier, and your Ctrl+Z only undoes your own items. A shipped agent skill teaches it to sketch well (spacing, labels, callouts, flows) and to verify its own work by rendering: [`integrations/skill/SKILL.md`](integrations/skill/SKILL.md).

No MCP? The board is just `board.json` next to `server.js`. Any agent that can read and write files can collaborate.

## Ask your AI to install it

Paste this into your AI coding agent (ZCode, Claude, Cursor, …) and let it do the setup:

```text
Set up Drawrdis, a local whiteboard you and I will share, on this machine:

1. Clone it and enter the folder:
   git clone https://github.com/SaldanhaC3/drawrdis.git && cd drawrdis
2. Start the board server in the background: node server.js
   (it serves http://127.0.0.1:3750 and auto-creates board.json)
3. Register the MCP server in your own MCP config so you can read and write
   the board, pointing at the absolute path to mcp-server.js in this folder.
   If you can't edit your config, tell me the exact JSON to paste and where.
4. Install the agent skill from integrations/skill/SKILL.md into your skills
   directory so you know how to draw well on the board.
5. Open http://127.0.0.1:3750, read the board with drawrdis_get_scene, and
   confirm to me that the board is live. Then draw a welcome card on it.
```

After that, both you and the agent are looking at the same board.

## Files and projects

- The live board auto-saves to `board.json`
- Menu → **Saved boards…** saves/opens named projects (stored in `boards/`)
- Menu → **Save .drawrdis file…** downloads the board as a portable file;
  double-clicking a `.drawrdis` file reopens it in Drawrdis (optional Windows
  association: `scripts/register-filetype-windows.ps1`)
- Drag-and-drop or Ctrl+O imports `.drawrdis` files and JSON exported from other whiteboard apps

## Tests

```sh
npm test
```

Spawns the server on port 3999 with a throwaway board in the OS temp dir
(never touches your `board.json`) and runs the 70-test e2e harness in headless
Chromium (needs Chrome/Chromium/Edge installed, or `CHROME_PATH` set).

## Architecture

| file | role |
|---|---|
| `server.js` | HTTP + SSE + persistence, per-item merge, ops log, revision guard (zero dependencies) |
| `public/index.html` | the whole editor: canvas, tools, panels, sync |
| `mcp-server.js` | MCP stdio server exposing the board as tools |
| `board.json` | the live board (created on first run) |
| `boards/` | named project snapshots |
| `files/` | externalized images, content-addressed (`/img/<sha1>.png`) |
| `boards/_history/` | automatic snapshots: every 20 revs and before destructive writes |

## Limitations (on purpose, for now)

- Local-only, single user, binds to `127.0.0.1`
- UI chrome is PT/EN (menu toggle); canvas hints are still Portuguese
- No real-time multi-human cursors (agent presence is in; human-to-human cursors are not)

## License

[MIT](LICENSE)
