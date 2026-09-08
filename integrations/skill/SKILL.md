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
   `drawrdis_get_scene` (`{format:"summary"|"json", since:rev}` — the summary
   includes `rev`, the board's version number; `since` returns only what
   changed), `drawrdis_add_items` (`{items:[...]}`),
   `drawrdis_update_items` (`{items:[patches with id]}` — field-level merge),
   `drawrdis_delete_items` (`{ids:[...]}`), `drawrdis_replace_scene`
   (`{title, items, rev}` — destructive, needs the `rev` you read, avoid),
   `drawrdis_wait_for_change` (`{rev, timeoutMs}` — blocks until the human
   edits, returns the changed `ids`), `drawrdis_layout`
   (`{ids, op, gap}` — align/distribute/place-right/grid),
   `drawrdis_user_state` (`{}` — the human's current selection + viewport),
   `drawrdis_render` (`{w,h,ids,bbox}` — returns the board (or a crop) as a
   PNG image).
2. **Local HTTP** (if the server is running): `GET /scene`, `GET /scene?since=N`
   (diff), `POST /sync` (per-item merge `{add,update,remove,order,merge}` —
   with `merge:true`, `update` entries are field patches, `null` deletes a
   field), `POST /scene?rev=N` (replaces EVERYTHING; rev required, auto-saves a
   snapshot first), `POST /items` (append), `DELETE /items/:id`,
   `GET /wait?rev=N&timeout=ms` (long-poll, returns changed ids),
   `GET /events` (SSE: `ops` diff events, `scene` full fallback),
   `POST /img` `{data:dataURL}` → `{src:"/img/<hash>.png"}`,
   `POST /layout` `{ids,op,gap}`, `GET|POST /state`, `GET /history`,
   `POST /history/revert`. Named projects: `GET /boards`,
   `GET|POST|DELETE /boards/:slug`.
   Saving a project does NOT touch the live board (`board.json`).
3. **File**: read/write `board.json` next to `server.js` directly. Any file
   write is pushed live to open browsers (SSE).

If the user says the tab is not open: ask them to run the launcher
(`bin/drawrdis.bat` / `bin/drawrdis.sh`), or start `server.js` yourself.

## Reading the board

Always start with `format:"summary"` — a `rev` line plus one line per item
(`id  type  @x,y  w×h  "text"`). Use `format:"json"` only when you need
styles/curves/bindings. To follow the human's edits without re-reading
everything: call `drawrdis_wait_for_change` with the `rev` you last saw — it
returns the changed `ids` — then `get_scene` with `since=that rev` to fetch
only what moved. `drawrdis_user_state` tells you what the human has selected
and which region they're looking at; use it before "fix this here" and pass
their `view` as `bbox` to `drawrdis_render` to see their exact crop.

## Writing (safety rules)

1. **Read before writing.** The board often has hundreds of user items.
2. To add content prefer `drawrdis_add_items` / `POST /items` — no risk of
   erasing the user's fresh work. To change an item prefer
   `drawrdis_update_items` with **only the fields you mean to change**
   (`{id, fill}`): the server merges it field-by-field, so if the user moved
   the item between your read and your patch, their position survives.
   Sending whole items is what caused lost updates before; don't.
3. `POST /scene` / `replace_scene` **replace the whole board**: only for full
   imports. `replace_scene` requires the `rev` you read — if the board moved
   since, the call fails and you must re-read first. Confirm with the user.
   The server snapshots the old state to `boards/_history` before replacing.
4. **Never delete user items without asking.** Agent writes bypass the
   editor's local undo, so mistakes are expensive.
5. Every write appears **on the user's screen in <1s** and your items flash
   in a colored outline — they are watching you draw. Keep one
   `add_items`/`update_items` call per logical piece (one screen, one fix) so
   the flash reads as intentional strokes, not a data dump.
6. Items you add or patch are stamped `by:"agent"`; the human's edits are
   stamped `by:"user"`. Use this to tell your work apart from theirs when
   reviewing the board.
7. Images: never paste big base64 dataURLs into items. Send the dataURL to
   `POST /img` and put the returned `/img/<hash>.png` URL in `src`.

## Scene schema

`{ version:1, title, bg:null|"#hex", bgMode:"dots"|"grid"|"lines"|"plain", items:[...] }`.
World coordinates, **y grows down**. Hex colors. Common fields: `stroke`,
`strokeWidth` (2/4/6), `strokeStyle` ("solid"|"dashed"|"dotted"), `roughness`
(0 straight, 1 hand-drawn, 2 scribbly), `opacity` (10-100), `angle` (radians),
`g` (group id — items sharing the same `g` get selected, moved and resized
together; set `g` on several items to group them, delete it to ungroup),
`by` ("user"|"agent" — who last edited it; the server stamps it for you),
`link` (`{to:"<itemId>"}` — in present mode (Alt+P) clicking this item jumps
the camera to that item/group: wire the prototype with one `update_items`),
and `locked` (true = the human froze it; don't move or delete locked items).

| type | own fields |
|---|---|
| `rect` | `x,y,w,h`, `r` (0 sharp, ~32 rounded), `fill`, `fillStyle` |
| `ellipse` | `x,y,w,h`, `fill`, `fillStyle` |
| `diamond` | `x,y,w,h`, `fill`, `fillStyle` |
| `text` | `x,y,text`, `fontSize`, `bold`, `fontFamily` ("hand"|"normal"|"code"), `textAlign`, `w` (container; text wraps), `autoW:true` grows with text |
| `line`/`arrow` | `x,y,x2,y2`, `mids:[[x,y],...]` curve points, `startBind:{id}`, `endBind:{id}` |
| `draw` | `points:[[x,y],...]` freehand |
| `image` | `x,y,w,h`, `src` (URL `/img/<hash>.png` preferred — get it via `POST /img`; dataURL still works but bloats the board file) |

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

Don't compute bboxes by hand. Add the items anywhere (e.g. at 0,0 with their
relative layout), then call `drawrdis_layout` with `{ids:[...your new items],
op:"place-right"}` — the server moves the whole group to the right of every
other item on the board, preserving your relative layout. `op:"grid"` tidies
a set into a grid; `align-*`/`distribute-*` straighten rows and columns.

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

### Clickable prototype (present mode)

Arrows show the flow to a human; `link` makes it clickable. One
`update_items` patch on the button:

```json
{"id":"<button id>","link":{"to":"<destination frame id>"}}
```

The destination is usually a screen's frame rect (any item works; the camera
jumps to its group box). The human presses Alt+P to present and clicks
through the prototype; linked items carry a small blue dot in edit mode.
When you review a board, check that every primary action has a `link` or a
bound arrow to a real destination.

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
- Render in crops, not whole: on a board with hundreds of items the full PNG
  is illegible. Pass `ids` (the frame you just drew — its group comes along)
  or `bbox` (e.g. the human's `view` from `drawrdis_user_state`) and read the
  close-up.
- `GET /?test=1` — built-in e2e harness (synthetic events, PASS/FAIL report
  in the DOM). Run it after touching any editor code.
- After writing, re-read the scene (or `since=rev`) and verify counts/positions.
