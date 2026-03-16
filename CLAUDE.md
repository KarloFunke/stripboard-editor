# Stripboard Editor - Project Context

## Overview
A web-based stripboard layout editor. Split-screen: schematic/net editor (left) + stripboard layout (right). Users define components, assign nets, place components on a virtual stripboard, and get visual feedback on connectivity, conflicts, and completeness.

## Tech Stack
- **Frontend**: Next.js 16 (App Router), TypeScript, React 19, Zustand, Tailwind CSS v4, SVG rendering
- **Backend**: Django 6, Django REST Framework, SQLite, Session auth
- **No dark mode** — forced light mode via `color-scheme: light` on html element
- **Accent color**: `#113768` (deep blue, matching owner's homepage)

## Project Structure
```
src/
  frontend/                    ← Next.js app (self-contained, own package.json)
    app/
      page.tsx                 ← Landing page (project list, new project, auth)
      project/[editUuid]/      ← Editor page (loads from API)
      view/[viewUuid]/         ← View-only page (fork button)
    components/
      ProjectToolbar.tsx       ← Top bar: project name, save, share, export/import
      SchematicEditor.tsx      ← Left panel wrapper (header + tag bar + sidebar + canvas)
      StripboardEditor.tsx     ← Right panel wrapper (header with board size + tray + canvas)
      schematic/
        SchematicCanvas.tsx    ← SVG canvas with drag, selection rect, net lines
        SchematicComponentBlock.tsx ← Individual component on schematic (inline label edit, tag paint)
        ComponentLibrary.tsx   ← Visual footprint picker (collapsible categories with SVG thumbnails)
        ComponentPopup.tsx     ← Edit popup (label, tag, pins, footprint, delete). Save on outside click, X = cancel
        FootprintEditor.tsx    ← Modal: grid editor for body cells and pins
        NetPanel.tsx           ← Net list with Auto New pseudo-net, color picker, inline rename
        netLines.ts            ← MST algorithm for net visualization lines
        blockLayout.ts         ← Schematic block sizing (accounts for body cells)
      stripboard/
        StripboardCanvas.tsx   ← SVG board: strips, holes, components, wires, cuts, selection rect
        PlacedComponent.tsx    ← Component on board (dotted rect, pin dots with IDs, tag label)
        ComponentTray.tsx      ← Sidebar: unplaced, on board, incomplete nets
        CutMark.tsx            ← X mark between holes
        WireLine.tsx           ← Clickable wire line (click to delete)
        boardLayout.ts         ← Grid constants (HOLE_SPACING=30, BOARD_PADDING=60), coordinate helpers
        stripSegments.ts       ← Strip segment computation (splits rows at cuts, finds nets)
        connectivity.ts        ← Union-Find for wire connectivity across segments
        netCompleteness.ts     ← Checks all net pins are electrically connected
        trayDragState.ts       ← Shared module-level state for tray drag component ID
    store/
      useProjectStore.ts       ← Zustand store (all project state + UI state + actions)
    hooks/
      useStripSegments.ts      ← Shared hook for memoized segments + connectivity
    types/
      index.ts                 ← All TypeScript interfaces
    data/
      defaultComponents.ts     ← Default component library (2-pin, 3-pin, inline, DIP)
    utils/
      resolveComponentDef.ts   ← Merges per-instance footprint override with base def
    lib/
      api.ts                   ← Backend API client (fetch wrapper, CSRF, SHA-256 password hashing)

  backend/                     ← Django project (own venv, requirements.txt)
    config/
      settings.py              ← All config from .env, no fallbacks
      urls.py
    projects/
      models.py                ← Project model (edit_uuid, view_uuid, fork_of, owner, JSON data)
      views.py                 ← API views (CRUD, fork, claim, auth)
      serializers.py           ← DRF serializers (SHA-256 password format validation)
      urls.py                  ← API routes under /api/
    venv/                      ← Python virtual environment
    .env                       ← Environment variables (not committed)
    requirements.txt
```

## Key Architecture Decisions

### Component System
- Components are footprint-based, not named by type. Library organized by physical shape: 2-Pin (various spacings), 3-Pin, Inline (4-10), DIP (4-20)
- **Tags** provide the semantic label (Resistor, LED, IC, etc.). Applied via paintbrush mode from tag bar. Stored per-instance on `Component.tag`
- **Labels** are short identifiers (R1, U1). Auto-generated based on active tag prefix (R for Resistor, C for Capacitor, etc.)
- **Per-instance footprint overrides**: `Component.footprintOverride` lets each instance customize pins/body independently. `resolveComponentDef()` merges override with base def
- **Pin names** editable per-instance (creates override on first edit)

### Net System
- Nets have name + color. VCC (red) and GND (black) pre-created
- **Auto New** pseudo-net (`__auto_new__` sentinel in activeNetId): click unassigned pin → creates new net with random color, becomes active
- Net lines on schematic use Prim's MST for minimal visual clutter
- Nets panel: click color swatch to change, double-click name to rename

### Stripboard
- Board is `rows × cols` grid, default 20×20, editable in header
- **Cuts** placed between holes (not on holes). `Cut.col` = between col and col+1
- **Wires** placed by clicking two holes directly on the board. Click existing wire to delete
- **Conflict detection**: Union-Find connectivity groups segments + wires. 2+ nets on same group = conflict (red)
- **Net completeness**: checks all pins of each net are in same connected group
- **All done** banner: shown when ≥2 components, all placed, no conflicts, all nets complete
- Components render as solid white rect with dotted edges, pin dots with IDs below

### Interactions
- **Schematic**: drag components, selection rectangle for bulk select, arrow keys to move, Delete to remove, inline label edit, tag paintbrush on component text below
- **Stripboard**: drag from tray (ghost preview shows footprint), drag on board to reposition, R to rotate, Delete to remove, selection rectangle + arrow keys for bulk move, click hole = start wire (unless component occupies it), click between holes = toggle cut
- **Component popup**: all edits held locally, Save button or outside click commits, X cancels

### Backend
- Session auth (Django sessions, 180-day cookie)
- Passwords: SHA-256 hashed on frontend before sending. Backend validates 64-char hex format (rejects non-hashed attempts silently as "Invalid credentials")
- Project data stored as JSON blob in SQLite
- Two UUIDs per project: edit_uuid (full access), view_uuid (read-only)
- Fork tracking via `fork_of` foreign key
- Anonymous project creation supported; `claim` endpoint to associate with account later

## User Preferences
- No type checking needed (`npx tsc --noEmit`) — user runs dev server and will report errors
- No dev server testing — user tests themselves
- Focus on UX over security complexity
- Prefers clean, minimal UI aligned with homepage colors (#113768 accent, #fafafa background, Inter font)
- Values fast workflows: paintbrush modes for nets and tags, inline editing, keyboard shortcuts
