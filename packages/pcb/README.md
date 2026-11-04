# @pcbcad/pcb

Board-level layout automation, checks and manufacturing outputs for PCBCAD. Pure TypeScript,
browser/worker safe (no Node built-ins); depends on `@pcbcad/core`, `clipper-lib` and `fflate`.
Board frame: mm, Y up, origin lower-left. No function mutates its inputs.

| Export | Purpose |
| --- | --- |
| `autoPlace(board, parts, opts?)` | connectivity-aware placement → `{ board, report }` |
| `autoRoute(board, parts, opts?)` | grid A* router with vias and rip-up → `{ board, routed, failed, stats }` |
| `fillZones(board, parts)` | copper pours (clipper-lib) → board with `zone.fill` |
| `connectivity(board, parts)` / `ratsnest(board, parts)` | copper islands per net / MST air wires |
| `runDrc(board, parts)` / `runErc(board, parts)` | `DesignIssue[]` (`category` `drc` / `erc`) |
| `exportGerbers(board, parts, opts?)` | RS-274X X2 Gerbers + Excellon drills |
| `exportBom(project, opts?)` / `exportCpl(board, parts)` / `zipFiles(files)` | assembly data, zip |
| `boardStats(board, parts)` | routed %, vias, trace length, copper and board area |
| `strokeText`, `textWidth`, `strokeWidthFor` | the built-in silkscreen stroke font |

## Geometry model

All copper is a *prim*: a core (point, segment or closed polygon) Minkowski-summed with a disc of
radius `r`. Circles, ovals, traces, rectangles and rounded rectangles are therefore exact, and
clearances are exact segment/segment distances (`geom.ts`). Pads come from core's `placedPads`
(bottom side mirrors X). Zone fills are even-odd ring lists regrouped into islands by nesting depth
(`region.ts`); large regions get an edge index for fast containment/gap queries. A uniform-grid
spatial index keeps DRC, connectivity and pour island tests near-linear.

## Connectivity / ratsnest

Union-find over items of the *same net* that share a copper layer and touch (gap ≤ 1 µm): pads,
trace segments, vias, plated holes, zone islands. Pads with the same number on one footprint are
internally connected; pads of unplaced parts never connect geometrically. The ratsnest is a Prim MST
between islands using pad centres, via centres and trace ends as anchors.

## DRC

Codes: `clearance`, `short` (different nets' copper touching), `unrouted`, `trace-width`, `drill`,
`annular-ring`, `edge-clearance`, `outside-board`, `courtyard-overlap` (same side, SAT on rotated
courtyards), `unplaced` (also used for parts without footprint), `silk-over-pad` (mask expansion
0.05 mm), `hole-to-hole` (0.25 mm drill edge to edge). Issues carry `at` and target ids and are
de-duplicated per object pair. Pad pairs inside one footprint are only reported when copper of two
nets overlaps (library land patterns are trusted). 2000+ objects check in ~0.1–0.2 s.

## ERC

`single-pin-net`, `unconnected-power-pin`, `output-conflict` (≥2 `output`/`power_out`),
`no-power-source` (power_in pins without power_out / connector / battery / regulator output; supply
propagates through fuses, ferrites, inductors, switches, diodes, MOSFETs and ≤1 Ω resistors),
`missing-decoupling` (IC supply pin net without a capacitor to a ground net), `floating-input`
(unconnected input pins, input-only nets), `nc-connected`.

## Copper pours (`fillZones`)

Per zone, highest priority first: (zone outline ∩ board outline inset by `edgeClearance` − cutouts)
− other-net pads/traces/vias/holes and higher-priority fills inflated by
`max(zone.clearance, rules.clearance)` (− same-net pads when `thermalRelief`) → morphological opening
by `minWidth` (default `rules.minTraceWidth`) → 4 thermal spokes per pad (width
`max(0.3, net trace width)`, kept only if they land on the fill) → islands touching no same-net pad,
via or trace are removed. All arcs are circumscribed, so fills are conservative (DRC clean). The
opening's dilation runs in vertical strips with overlap (exact) to keep clipper's sweep cheap: two
full-board pours on a 150-part / 1000-segment board take ~1.5 s.

## Router (`autoRoute`)

* **Grid**: nodes at multiples of `grid` (default `rules.routingGrid`) on every routing layer
  (`opts.layers`, default the whole stack); the pitch is coarsened above 1.5 M nodes.
* **Obstacles** are rasterised into per-*width-class* count grids. A node is blocked when its centre
  is within `clearance + halfWidth + m` of other-net copper, with
  `m = √(D² + L²/4) − D` (`D` = clearance + half width, `L` = move length): two discs of that radius
  cover the stadium of radius `D` around any straight move, so every move between free nodes is
  clearance-safe. Orthogonal and diagonal moves use separate margins, which lets full-width traces
  reach 0.5–0.65 mm pitch pads. Counts are additive: committing or ripping up a route is exact.
* **Vias** are point obstacles checked on every stack layer, keep 0.25 mm hole-to-hole spacing and are
  never placed in SMD pads.
* **Search**: per net, islands are joined in Prim order; A* (octile heuristic, 45°/90° moves) runs from
  all copper of the new island to all copper of the growing tree (pads anywhere inside their copper,
  earlier routes, pre-existing traces/vias), giving Steiner-like trees. Costs: length, layer
  direction preference (top horizontal, bottom vertical, …), bends, `viaCost` (default max(1, 6·grid)
  mm) and congestion history. The search first runs in a bounding window, then on the full board.
  Off-grid fine-pitch pads are entered through exactly-checked stubs; failing connections retry with
  `rules.traceWidth` then `rules.minTraceWidth` (neck-down).
* **Rip-up and reroute** (`ripupPasses`, default 20, only while failures remain): failed connections
  may cross other nets' router-placed copper at a penalty; crossed nets are ripped up, history costs
  rise on contested nodes and victims are re-queued. Pre-existing copper is never ripped.
* **Output**: collinear steps merged into minimal polylines (one trace per layer run) ending at pad
  centres when that is clearance-safe; every segment and via is finally verified exactly against all
  other-net copper (a failing net is removed and reported). Zones that had fills are refilled.
* Width per net: `net.traceWidth ?? (power/ground → rules.powerTraceWidth) ?? rules.traceWidth`.
* Performance: the 50×40 mm, 25-part, 30-net test board routes in ~0.2 s; a 100×80 mm, 150-part,
  113-net board in ~1.5–2.5 s.

## Placer (`autoPlace`)

1. Locked parts (and placed ones with `keepPlaced`) are fixed obstacles.
2. Connectors (category `connector` or refs `J*`, `P*`, `CN*`, `USB*`) go to edges — `opts.edges`
   wins; `offset` is measured from the edge centre. They face outward using
   `ConnectorSpec.matingDirection` when known, otherwise their long side runs along the edge.
3. ICs are placed by connectivity; each IC immediately gets its decoupling capacitors (capacitor on
   an IC power-pin net + ground) beside the pin, supply pad toward it, and crystals beside its XTAL
   pins with their load caps.
4. Other parts go to the weighted centroid of placed neighbours (power/ground nets down-weighted),
   picking the 90° rotation with the lowest half-perimeter wirelength.
5. Seeded simulated annealing (moves, rotations, swaps of similar parts) on the `routingGrid` lattice.

Legality is enforced throughout (courtyard + `spacing` (0.5 mm) on the same side, THT parts block both
sides; courtyards inside the outline inset by `edgeClearance`, outside cutouts and mounting-hole
keep-outs) using a summed-area table of the allowed area and a spatial index. On sparse boards parts
get a routing halo (∝ √pins) so the inflated area reaches ~45 % of the board; satellites ignore their
anchor's halo. Parts that do not fit stay `placed: false` and are reported. 150 parts: ~0.6 s.

## Manufacturing outputs

* Gerber RS-274X, `%FSLAX46Y46*%`, mm, X2 file attributes (`TF.FileFunction`, `FilePolarity`, …) and
  aperture functions. Apertures are collected first, so all are defined before use; files end `M02*`.
  Layers: copper (`F_Cu`, `In1_Cu…`, `B_Cu`), mask (negative polarity, pads + 0.05 mm, vias tented),
  paste (SMD pads scaled by √`pasteRatio` — the ratio is an area ratio), silkscreen (footprint
  graphics + reference designators in the stroke font, mirrored on the bottom, clipped away from
  exposed pads), `Edge_Cuts` (outline + cutouts). Axis-aligned rect/oval/circle pads are flashed,
  rotated ovals are stroked, everything else is a G36/G37 region. Zone fills are regions written
  largest island first: outer ring dark, holes clear (`%LPC*%`).
* Excellon: `PTH.drl` (vias, THT pads, plated holes) and `NPTH.drl`, `METRIC`, decimal coordinates,
  tool table `TnC<d>` grouped by size and function, slots as `G85`.
* BOM CSV `Designator,Qty,Value,MPN,Manufacturer,Package,LCSC,Unit Price,Ext Price,Stock`: identical
  part+value grouped, DNP and mechanical parts excluded, Qty per board, unit price from the price break
  for Qty × build quantity, Ext Price = Unit × Qty.
* CPL (JLCPCB): `Designator,Mid X,Mid Y,Layer,Rotation` with `mm` units, rotation CCW in [0, 360).

## Limits

* Through vias only (no blind/buried/micro vias); no differential pairs, length tuning or
  per-net-class clearances (one `rules.clearance`).
* The router ignores existing zone fills as obstacles (they are refilled afterwards) and does not add
  stitching vias: nets meant to be connected by a pour should be passed in `skipNets`.
* Grid routing cannot use space finer than the grid; very dense boards may need a finer `grid` or
  more layers.
* Annealing stops at a time budget (~0.8 s), so very large boards may differ slightly between
  machines; results are otherwise deterministic for a given `seed`.
* Courtyards are treated as their bounding boxes in the placer (rotations are 90° steps).
* CPL rotation is the raw component rotation; some assembly houses apply their own bottom-side or
  package-specific offsets.
