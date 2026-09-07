---
name: drawrdis
description: Operate Drawrdis, the user's local hand-drawn-style whiteboard (app screens, flows, wireframes). Use when the user mentions Drawrdis, "the board", "the sketch", "the screens", asks to draw/show/edit/review sketches, or when visualizing interface ideas before coding would help.
---

# Drawrdis — shared whiteboard (user + AI)

Drawrdis is a local hand-drawn-style board. The user draws in a browser tab;
you (the AI) read and write the board directly, near real-time. It is the
shared paper for thinking through interfaces before coding.

## Where it lives

| thing | path |
|---|---|
| install dir | wherever the user cloned Drawrdis (contains `server.js`) |
| **board (source of truth)** | `<install dir>/board.json` |
| web server | `node <install dir>/server.js` (port 3750-3760, or `$DRAWRDIS_PORT`) |
| URL | `http://127.0.0.1:3750` |
| named projects | `<install dir>/boards/*.json` |

## How to connect (3 ways, best first)

1. **MCP**: if registered in the client config, tools load automatically:
   `drawrdis_get_scene` (`{format:"summary"|"json"}` — the summary includes
   `rev`, the board's version number), `drawrdis_add_items` (`{items:[...]}`),
   `drawrdis_update_items` (`{items:[patches with id]}`),
   `drawrdis_delete_items` (`{ids:[...]}`), `drawrdis_replace_scene`
   (`{title, items, rev}` — destructive, needs the `rev` you read, avoid),
   `drawrdis_wait_for_change` (`{rev, timeoutMs}` — blocks until the human
   edits), `drawrdis_render` (`{w,h}` — returns the board as a PNG image).
2. **Local HTTP** (if the server is running): `GET /scene`, `POST /sync`
   (per-item merge `{add,update,remove,order}` — safe against concurrent
   edits), `POST /scene` (replaces EVERYTHING; `?rev=N` rejects stale writes),
   `POST /items` (append), `DELETE /items/:id`, `GET /wait?rev=N&timeout=ms`
   (long-poll), `GET /events` (SSE). Named projects: `GET /boards`,
   `GET|POST|DELETE /boards/:slug`.
   Saving a project does NOT touch the live board (`board.json`).
3. **File**: read/write `board.json` next to `server.js` directly. Any file
   write is pushed live to open browsers (SSE).

If the user says the tab is not open: ask them to run the launcher
(`bin/drawrdis.bat` / `bin/drawrdis.sh`), or start `server.js` yourself.

## Reading the board

Always start with `format:"summary"` — a `rev` line plus one line per item
(`id  type  @x,y  w×h  "text"`). Use `format:"json"` only when you need
styles/curves/bindings. HTTP equivalent: `GET /scene`. To follow the human's
edits without re-reading, call `drawrdis_wait_for_change` with the `rev` you
last saw.

## Writing (safety rules)

1. **Read before writing.** The board often has hundreds of user items.
2. To add content prefer `drawrdis_add_items` / `POST /items` — no risk of
   erasing the user's fresh work. All writes are per-item merges: if the
   user draws while you write, neither of you loses items.
3. `POST /scene` / `replace_scene` **replace the whole board**: only for full
   imports. `replace_scene` requires the `rev` you read — if the board moved
   since, the call fails and you must re-read first. Confirm with the user.
4. **Never delete user items without asking.** Agent writes bypass the
   editor's local undo, so mistakes are expensive.
5. Every write appears **on the user's screen in <1s** — they are watching.
6. Keep the previous JSON before overwriting (`GET /scene`), so you can
   restore.

## Scene schema

`{ version:1, title, bg:null|"#hex", bgMode:"dots"|"grid"|"lines"|"plain", items:[...] }`.
World coordinates, **y grows down**. Hex colors. Common fields: `stroke`,
`strokeWidth` (2/4/6), `strokeStyle` ("solid"|"dashed"|"dotted"), `roughness`
(0 straight, 1 hand-drawn, 2 scribbly), `opacity` (10-100), `angle` (radians).

| type | own fields |
|---|---|
| `rect` | `x,y,w,h`, `r` (0 sharp, ~32 rounded), `fill`, `fillStyle` |
| `ellipse` | `x,y,w,h`, `fill`, `fillStyle` |
| `diamond` | `x,y,w,h`, `fill`, `fillStyle` |
| `text` | `x,y,text`, `fontSize`, `bold`, `fontFamily` ("hand"|"normal"|"code"), `textAlign`, `w` (container; text wraps), `autoW:true` grows with text |
| `line`/`arrow` | `x,y,x2,y2`, `mids:[[x,y],...]` curve points, `startBind:{id}`, `endBind:{id}` |
| `draw` | `points:[[x,y],...]` freehand |
| `image` | `x,y,w,h`, `src` (dataURL) |

**Bound arrows**: with `startBind`/`endBind` set to a shape's `id`, the end
recalculates on the shape's border (toward the other end) whenever the shape
moves/resizes. Deleting the shape releases the arrow.

## Visual conventions (match the user's style)

- Default look: `roughness:1`, `fontFamily:"hand"`, stroke `#1b1b1f`,
  `strokeWidth:2`, `opacity:100`.
- Common palette: orange `#e8734a`, green `#2f9e44`, red `#e03131`,
  blue `#1971c2`, yellow `#f08c00`, gray `#9a938c`.
- Phone frame: rect `340×660`, `r:24`, `strokeWidth:3`, fill `#ffffff`.
- Button: rect `150×46` `r:10` orange + centered white text 16.
- Screen title: text 20 bold above the frame.

## Recipes

### New content without overlapping anything

Read the scene, compute the bbox of everything, place to the right:

```js
let maxX = -1e9, minY = 1e9;
for (const it of scene.items) { /* bbox per item */ maxX = Math.max(maxX, b.bx+b.w); minY = Math.min(minY, b.by); }
// new content starts at x = maxX + 160, y = minY
```

### A new screen (consistent style)

1. Phone frame + title above it.
2. Components inside with ~40px margins.
3. Labels in hand font, 15-20px.
4. Prefer one `drawrdis_add_items` call with the whole screen as an array.

### Flows between screens

Arrow with binding from source element to destination:

```json
{"type":"arrow","x":310,"y":404,"x2":540,"y2":300,
 "stroke":"#1b1b1f","strokeWidth":2,"roughness":1,
 "startBind":{"id":"<source button id>"},"endBind":{"id":"<dest screen id>"}}
```

Ends snap to borders and follow shapes. (The user does this with
Ctrl+arrows / Ctrl+Enter in the editor.)

## Drawing well: clear, legible diagrams

1. **40px mental grid**: align siblings on the same y (row) or same x
   (column). Use multiples of 20/40.
2. **Breathing room**: 60-80px between unrelated elements; 16-24px between a
   label and what it describes.
3. **One concept per group**: group title + components. More than ~7
   elements? Split into subgroups.
4. **Hierarchy**: titles 20-28px bold; labels 14-16px; annotations 12-13px
   gray `#9a938c` or accent color.
5. **Consistent color semantics**: action orange `#e8734a`; navigation blue
   `#1971c2`; positive green `#2f9e44`; alert red `#e03131`; annotation
   yellow `#f08c00`. Explain the color code in a legend.

### Callouts (annotations)

- Annotation text (12-14px, accent color) + a **dotted line** to near the
  element's border: `{type:'line', stroke:'#f08c00', strokeWidth:1,
  strokeStyle:'dotted', roughness:0}`.
- Or a sticky note: rect 140×90 `fill:'#ffec99'`, `fillStyle:'solid'`, `r:8`
  + 12px text inside, line leaving toward the element.
- Place annotations OUTSIDE the target element, ~12px away.

### Button function captions

Under a button/component, two stacked labels:
- the button name ("Share") 12px in the button color
- the function ("→ opens share sheet") 12px gray, same x, y +16

### Relations between elements

- **Navigation flow**: bound `arrow` source → destination. Avoid crossings:
  detour with `mids:[[x,y]]`.
- **Conceptual relation**: gray dashed `line`, no arrowhead.
- **Grouping**: thin rect around the group (`fill:'transparent'`,
  `strokeStyle:'dashed'`, `strokeWidth:1`, gray) with the group title inside
  top-left.

### Pre-delivery checklist

1. Nothing overlapping (title over a frame? arrow crossing text? detour).
2. Rows and columns straight.
3. Every important element labeled; every relation has an obvious source.
4. Render via `drawrdis_render` and LOOK at the PNG. If you can't read it in 3
   seconds, neither can the user.
5. Mark open questions with a gray "?" instead of guessing silently.

## Reviewing the board (refinement mode)

When asked to review (or after drawing):

1. Read the whole board and map it: screens, existing flows (bound arrows),
   loose items.
2. Check consistency: untitled screens; screens with no arrows (orphans);
   buttons with no declared function; crossings; overlaps; uneven spacing.
3. Check flow completeness: does every primary action have a destination?
   Point out dead ends.
4. Report a prioritized list (do NOT draw without asking):
   - red: breaks the flow (action without destination, unreachable screen)
   - yellow: clarity (ambiguous label, crossing arrow, overlap)
   - green: polish (alignment, spacing, missing title)
5. Offer the fix: "want me to align/title/link X→Y myself?" Then use
   `update_items` / `add_items` per the recipes.

## Verifying your work

- `drawrdis_render` — returns the board as a PNG in the tool response. LOOK
  at it before saying done: overlaps, alignment and legibility are only
  visible in the render, not in the JSON. Needs the server running and a
  Chrome/Edge installed.
- `GET /?test=1` — built-in e2e harness (synthetic events, PASS/FAIL report
  in the DOM). Run it after touching any editor code.
- After writing, re-read the scene and verify counts/positions.
