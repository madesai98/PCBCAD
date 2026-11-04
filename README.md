# PCBCAD

**Agent-driven, browser-based PCB + mechanical CAD and simulation for complete hardware products.**

PCBCAD works like [t3code](https://github.com/pingdotgg/t3code), but for hardware. It runs a
small local bridge that drives the AI agent CLI you already have installed and logged in:
**Claude Code**, **OpenAI Codex** or **Gemini CLI**. Your own subscription and the CLI's own
terms apply, and no API keys are stored. The agent designs the product through a set of design
tools. You watch it happen live in a modern web UI and review the result.

What the agent can do:

- **Real parts.** It searches the JLCPCB/LCSC catalogue (Mouser too, with an API key). Importing
  a part deterministically pulls specs, price breaks, stock, datasheet, pinout, footprint and 3D
  model from the JLCEDA/EasyEDA library. It also infers a simulation model, thermal data and a
  connector spec. When data is missing, the agent fills the gap from the datasheet with
  `define_part`, and that is shown to you as *agent-provided*.
- **Schematics and multi-board PCBs.** Netlist-driven schematics, auto-placement, a 45° maze
  autorouter with vias, copper pours, DRC/ERC, and boards linked by real connectors and cables
  (housings, crimps, wire). Any distributor connector can be configured as a *functional
  connector*: mating family, contact resistance, current rating, pin map and enclosure opening.
- **Mechanical.** Injection-molded enclosures (bosses, ribs, cut-outs, vents, snaps, lip/groove,
  draft), sheet-metal parts (true bends, K-factor flat patterns, DXF), custom CSG parts,
  fasteners (screws, heat-set inserts, standoffs) and a full assembly with exploded and section
  views. Material **and** manufacturing process set the as-built properties used by every
  simulation: knit lines, fibre orientation, FDM layer adhesion, die-cast porosity, finish
  emissivity.
- **Simulation.**
  - SPICE-class circuit simulation (DC and transient) per board or for the whole multi-board
    system, including cable and contact resistance.
  - PCB thermal: copper/FR-4 conduction, convection and radiation, component heating, trace
    Joule heating, IPC-2221 trace capacity, IR drop.
  - **Firmware-in-the-loop.** Real `.hex`/`.bin`/`.uf2` firmware runs on emulated MCUs
    (ATmega328P via avr8js, RP2040 via rp2040js, or an emulator the agent writes). Other chips
    are modelled with small JavaScript behaviour scripts (built-ins: BME280, 74HC595, 24C02,
    SSD1306).
  - Voxel FEA stress analysis, drop/impact (energy method), and conjugate heat-transfer CFD for
    airflow and heating inside the enclosure.
- **Manufacturing.** DFM checks for molding and sheet metal, assembly checks (interference,
  boss alignment, connector cut-outs, clearances), cost estimate, and an export zip with
  Gerbers, Excellon drills, BOM, CPL, STL and DXF.

## Quick start

Requirements: Node.js ≥ 20.10 and at least one agent CLI on your PATH (`claude`, `codex` or
`gemini`), already logged in. A scripted **demo agent** is built in, so you can try the full
pipeline without any CLI.

```bash
npm install
npm run build        # builds the web app + bundles the bridge
npm start            # http://127.0.0.1:4321 (opens your browser)
```

Development, with hot reload for the web and the server:

```bash
npm run dev          # bridge on :4321 (tsx watch) + Vite on :5173
```

Data lives in `~/.pcbcad` by default; override it with `--data-dir` or `PCBCAD_DATA_DIR`. In
dev mode it goes to `.pcbcad-data/` in the repo.

Optional extras:
- **avr-gcc + avr-libc** (`apt install gcc-avr avr-libc`, `brew install avr-gcc`) lets agents
  compile AVR test firmware with `build_firmware`.
- A **Mouser API key** (Settings) adds Mouser search results.

## How it works

```
 Browser (React + three.js)  ◀──── WebSocket (live project snapshots, chat stream) ────┐
                                                                                       │
                     ┌────────────────────────── PCBCAD bridge (Node) ─────────────────┴─┐
                     │  project store · checkpoints · design tool registry (~60 tools)   │
 agent CLI  ◀─spawn──┤  provider adapters: claude -p --output-format stream-json …       │
 (claude/codex/      │                      codex exec --json …, gemini -p … stream-json  │
  gemini)            │  worker pool: router · meshing · FEA · CFD · thermal · emulators   │
    │                └──────────────────────────────▲───────────────────────────────────┘
    │ spawns (stdio MCP)                            │ HTTP + per-turn token
    └──────────▶  pcbcad-mcp.mjs  ──────────────────┘
```

1. Each chat turn spawns the selected CLI in non-interactive streaming mode. The bridge passes a
   one-off MCP config pointing at `pcbcad-mcp.mjs`, a dependency-free stdio MCP server that
   forwards tool calls to the bridge with a per-turn token. Conversations resume with the CLI's
   own session id (`--resume`, `exec resume`).
2. Built-in CLI tools are restricted to research (web search/fetch, reading attachments). The
   design itself only changes through PCBCAD tools.
3. Each tool mutates the project and pushes a snapshot to the browser, so you see components
   appear, traces route and simulations finish in real time. Every turn creates a checkpoint,
   and **Revert** restores the design to before that turn.
4. Heavy work (routing, meshing, FEA/CFD, firmware emulation) runs in worker threads.

## Repository layout

| Package | Contents |
|---|---|
| `packages/core` | Shared data model (project/parts/boards/mechanical/assembly/simulation types), materials + process-adjusted properties, units, geometry, netlist and BOM helpers, wire protocol |
| `packages/parts` | Distributor pipeline (JLCPCB/LCSC/EasyEDA/Mouser), EasyEDA → footprint/pins/3D conversion, IPC-7351 footprint generators, parametric 3D bodies, sim-model/connector/thermal inference, fastener and offline part catalogs |
| `packages/pcb` | Auto-placement, maze autorouter, copper pours, DRC/ERC, Gerber/Excellon/BOM/CPL export |
| `packages/sim` | Circuit MNA solver, mixed-signal co-simulation with MCU emulators and behaviour scripts, PCB thermal + trace currents, voxel FEA + drop, CFD |
| `packages/mech` | Enclosure/sheet-metal/CSG geometry (manifold-3d), voxelisation, flat patterns + DXF, STL, DFM rules, assembly checks, auto-enclosure, cost models |
| `apps/server` | The bridge: HTTP/WebSocket API, project store, tool registry, agent adapters, MCP proxy, worker pool |
| `apps/web` | The browser UI |
| `examples/firmware` | Real AVR firmware used by the demo (BME280 environment monitor) |

## Tests

```bash
npm test                     # unit tests for all packages
npm run typecheck
npx tsx apps/server/scripts/e2e-demo.ts   # full end-to-end run with the scripted demo agent
```

## Accuracy notes

The simulators are engineering *screening* tools. Use them to catch design mistakes early, not
for certification. Each engine documents its method and limits in its package `README.md`:

- The CFD is laminar and coarse-grid.
- Drop tests use an equivalent-static energy method.
- FEA is linear elastic on voxels.
- Thermal models are steady state.
