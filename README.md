# PCBCAD

**Agent-driven, browser-based PCB + mechanical CAD and simulation for complete hardware products.**

PCBCAD works like [t3code](https://github.com/pingdotgg/t3code), but for hardware. A small local
bridge drives the AI agent CLI already installed and logged in on your computer: **Claude Code**,
**OpenAI Codex** or **Gemini CLI**. Your own subscription and each CLI's terms apply, and no API
keys are stored. The agent designs the whole product through about 60 design tools. You watch it
happen live in the browser and review the result. The UI is for watching and reviewing, not a
SolidWorks-style manual editor.

In one session the agent can take a product from requirements to a manufacturing package:

| | |
|---|---|
| **Real parts** | Live search of the JLCPCB/LCSC catalogue (Mouser too with an API key). `import_part` deterministically fetches specs, price breaks, stock, datasheet, pinout, footprint and 3D model from the JLCEDA/EasyEDA library, and infers a simulation model, thermal data and a *functional connector* spec. Gaps go back to the agent (`define_part`), which fills them from the datasheet; every facet is labelled *fetched / generated / agent* for review. |
| **Schematic & PCB** | Netlist-driven schematics with auto-layout, connectivity-aware auto-placement (connectors slid flush to the board edge), a 45° maze autorouter with vias and a fine-grid retry, copper pours with thermal reliefs and automatic stitching, DRC and ERC. |
| **Multi-board** | Boards linked by real connectors and cables: housings, crimps and wire as BOM lines. Any distributor connector can be made *functional* with mating family, contact resistance, current rating, pin map and enclosure opening. System-level simulation includes wire and contact resistance. |
| **Power inputs** | `set_external_supply` declares where power enters (USB-C charger, bench supply, battery); every simulation uses it. |
| **Mechanical** | Injection-molded enclosures with real draft, bosses with gussets, ribs, lip/groove, connector cut-outs, vents and snap fits. Sheet metal with true bends, K-factor flat patterns and DXF. CSG custom parts. Fasteners: ISO screws, heat-set inserts, standoffs. A full assembly with explode, x-ray and section views. |
| **Materials × process** | Simulations use *as-built* properties from the material plus the chosen process: knit lines, glass-fibre orientation, FDM layer adhesion, die-cast porosity, finish emissivity. |
| **Simulation** | SPICE-class circuit DC and transient, per board or system-wide. PCB thermal (copper/FR-4 conduction, convection and radiation, trace Joule heating, IPC-2221 capacity, IR drop). **Firmware-in-the-loop**: real `.hex/.bin/.uf2` images run on emulated MCUs (ATmega328P via avr8js, RP2040 via rp2040js, or an emulator the agent writes), and other chips run as sandboxed JavaScript behaviour models. Voxel FEA stress, drop/impact, and conjugate-heat-transfer CFD for airflow and heating in the enclosure. |
| **Manufacturing** | Molding and sheet-metal DFM; assembly checks (interference, boss alignment, connector recess, thread engagement, clearances); cost estimate. One zip with Gerbers (RS-274X X2), Excellon drills, BOM and CPL (JLCPCB format), STL meshes and DXF flat patterns. |

## Quick start

Requirements: Node.js ≥ 20.10. For real design work you also need an agent CLI on your `PATH`,
logged in: `claude`, `codex` or `gemini`. A built-in **scripted demo agent** runs the whole
pipeline without any CLI.

```bash
npm install
npm run build        # web app + bridge bundle
npm start            # → http://127.0.0.1:4321 (opens the browser)
```

Development, with hot reload for both the web app and the bridge:

```bash
npm run dev          # bridge on :4321 (tsx watch) + Vite on :5173
```

Create a product, pick an agent under the composer (installed CLIs are detected automatically),
and describe what you want. To see everything at once, pick **Demo agent** and send *"build the
demo"*. In about a minute it builds a USB-C environmental monitor:

- an ATmega328P main board, cabled to a BME280 probe board;
- firmware compiled with avr-gcc and run in the emulator against the BME280 model;
- a PC/ABS enclosure and an aluminium wall bracket;
- circuit, thermal, firmware, stress, drop and airflow simulations, DFM, and the export.

Data lives in `~/.pcbcad` by default; change it with `--data-dir` or `PCBCAD_DATA_DIR`. In dev mode
it goes to `.pcbcad-data/` in the repo.

Optional:
- **avr-gcc + avr-libc** (`apt install gcc-avr avr-libc` / `brew install avr-gcc`) lets agents compile AVR test firmware with `build_firmware`.
- **RP2040 boot ROM**: not redistributed, because part of it is licensed only for RP2040 silicon or under GPLv2. Put your own copy at `<dataDir>/rp2040-bootrom.bin` to run pico-sdk or MicroPython images. Bare-metal images run without it.
- **Mouser API key** (Settings) adds Mouser search results.

## How it works

```
 Browser (React + three.js)  ◀── WebSocket: live project snapshots, chat stream, sim progress ──┐
                                                                                               │
                     ┌──────────────────────────── PCBCAD bridge (Node) ────────────────────────┴┐
                     │ project store + per-turn checkpoints · ~60 design tools · worker pool      │
 agent CLI  ◀─spawn──┤ adapters: claude -p --output-format stream-json · codex exec --json ·     │
 claude / codex /    │           gemini -p --output-format stream-json · scripted demo agent      │
 gemini              │ engines: parts · pcb · sim (circuit, mixed-signal, thermal, FEA, CFD) · mech│
    │                └──────────────────────────────────▲─────────────────────────────────────────┘
    │ spawns (stdio MCP)                                 │ HTTP + per-turn token
    └──────────▶  pcbcad-mcp.mjs (dependency-free) ──────┘
```

1. Each chat turn spawns the selected CLI in non-interactive streaming mode. The bridge passes a
   one-off MCP config for `pcbcad-mcp.mjs`, a dependency-free stdio MCP server that forwards each
   tool call to the bridge with a per-turn token. Conversations resume through the CLI's own
   session id (`--resume`, `exec resume`).
2. Built-in CLI tools are limited to research (web search/fetch, reading attachments). The design
   changes only through PCBCAD tools.
3. Every tool call mutates the project and pushes a snapshot to the browser. You see parts appear,
   traces route and simulations finish in real time.
4. Every turn records a checkpoint. **Revert** in the chat restores the design to before that turn.
5. Routing, meshing, FEA, CFD, thermal and emulation run in worker threads.

## Tools the agent gets

| Group | Tools |
|---|---|
| Project | `get_design_overview`, `set_project_info`, `add_design_note`, `get_issues` |
| Parts | `search_parts`, `import_part`, `get_part`, `define_part`, `configure_connector`, `list_fasteners` |
| Schematic | `create_board`, `update_board`, `add_components`, `update_component`, `remove_components`, `connect`, `disconnect`, `set_net`, `set_external_supply`, `get_netlist`, `run_erc` |
| Layout | `auto_place`, `move_components`, `add_mounting_holes`, `auto_route`, `add_trace`, `add_via`, `clear_routing`, `add_zone`, `run_drc` |
| Multi-board | `connect_boards`, `remove_interconnect` |
| Mechanical | `list_materials`, `create_enclosure`, `add_enclosure_shell`, `update_mech_part`, `add_shell_feature`, `remove_shell_feature`, `create_sheet_metal_part`, `create_custom_part`, `place_in_assembly`, `add_fastener`, `run_dfm`, `get_flat_pattern`, `estimate_cost` |
| Simulation | `simulate_circuit`, `simulate_pcb_thermal`, `simulate_structural`, `simulate_drop`, `simulate_airflow`, `list_simulations`, `get_simulation` |
| Firmware | `list_firmware`, `configure_mcu`, `get_scripting_api`, `write_behavior_script`, `build_firmware`, `run_firmware_simulation` |
| Export | `export_manufacturing` |

The same tools back the UI's buttons (DRC, route, thermal, DFM, export), so you can also run them
yourself.

## Repository layout

| Package | Contents |
|---|---|
| `packages/core` | Shared data model (project, parts, boards, mechanical, assembly, simulation results), materials library with process-adjusted properties, units, geometry, netlist and BOM helpers, wire protocol |
| `packages/parts` | JLCPCB/LCSC/EasyEDA/Mouser pipeline, EasyEDA → pins/footprint/3D conversion, IPC-7351 footprint and parametric 3D generators, sim-model/connector/thermal inference, offline + fastener catalogs |
| `packages/pcb` | Auto-placement, maze autorouter, copper pours, connectivity, DRC/ERC, Gerber/Excellon/BOM/CPL export |
| `packages/sim` | Sparse MNA circuit solver, mixed-signal co-simulation (avr8js, rp2040js, sandboxed scripts), PCB thermal and trace currents, voxel FEA and drop, CFD |
| `packages/mech` | Enclosure, sheet-metal and CSG geometry (manifold-3d), fasteners, voxelisation, flat patterns, DXF/STL/3MF, DFM rules, assembly checks, auto-enclosure, cost models |
| `apps/server` | The bridge: HTTP/WebSocket API, store, tool registry, agent adapters, MCP proxy, worker pool |
| `apps/web` | Browser UI: chat, overview, schematic, PCB, 3D, parts/BOM, simulations, firmware, manufacturing |
| `examples/firmware` | Real AVR firmware used by the demo (BME280 environment monitor, blink) |

Each engine package has a `README.md` describing its methods, validation and limits.
`packages/sim/src/mixed/README.md` is the behaviour-scripting API; agents read it through
`get_scripting_api`.

## Tests

```bash
npm test                                   # ~590 unit/integration tests across all packages
npm run typecheck
npx tsx apps/server/scripts/e2e-demo.ts    # full product build with the scripted demo agent
npx tsx apps/server/scripts/e2e-demo.ts --provider claude --model haiku --prompt "…"   # real CLI
npx tsx apps/server/scripts/inspect-part.ts C14877   # run the parts pipeline for one part
```

## Accuracy and limits

The simulators are engineering **screening** tools. Use them to catch design mistakes early, not
for certification.

- **Circuit:** no junction capacitances, and op-amp gain-bandwidth is ignored.
- **Mixed-signal:** buses are transaction-level, so a level shifter between the MCU and a chip
  breaks bus matching.
- **PCB thermal:** steady state. Convection correlations are about ±25 %, and default θJC values
  about ±50 %.
- **FEA:** linear elastic on voxels.
- **Drop test:** an equivalent-static, shock-response-corrected estimate, good to about ±2×.
- **CFD:** laminar and coarse-grid, with no internal radiation. PCBs and IC packages use effective
  conductivities.
- **Routing:** through vias only, with no differential pairs or length tuning.
- **Sheet metal:** no hems over 175° or jogs.

## Data attribution

Symbols, footprints and 3D models marked *fetched* come from the JLCEDA/EasyEDA official library
([easyeda.com](https://easyeda.com) · [lceda.cn](https://lceda.cn)). Prices and stock are
JLCPCB/LCSC snapshots taken at import time.
