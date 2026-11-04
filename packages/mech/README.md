# @pcbcad/mech

Parametric mechanical geometry for PCBCAD: injection-molded enclosure shells, sheet metal (3D,
flat pattern, DXF), custom CSG parts, purchased envelopes/fans and fasteners; mass properties;
STL/3MF export; voxel models for structural and airflow simulation; molding and sheet-metal DFM;
assembly checks; automatic enclosure design around boards; rough cost models.

All lengths are millimetres, angles degrees, masses grams (see `@pcbcad/core` common.ts).

```ts
import { initGeometry, buildPartMesh, flatPattern, exportDxf, checkMoldability, autoEnclosure, checkAssembly } from '@pcbcad/mech';
await initGeometry();                       // optional: buildPartMesh() calls it too
const mesh = await buildPartMesh(shell, { project });   // MeshData, single group
```

## Architecture

Every part is first converted to a small CSG **Solid IR** (`solid.ts`: prisms, drafted rounded-rect
lofts, boxes, cylinders, spheres, revolves, booleans with row-major matrices). The IR has two
evaluators that use the same polygons:

| evaluator | used by | runtime |
|---|---|---|
| `solidToManifold` (manifold-3d, WASM) | `buildPartMesh`, STL/3MF, `massProperties` | async init, Node + browser |
| analytic point membership + scanline rasteriser | `voxelizePart`, `voxelizeForStructural`, `voxelizeAssemblyForAirflow`, `checkAssembly`, `estimateCost` | pure JS, sync |

Cylinders/revolves use manifold's n-gon (vertex 0 on +X) in both evaluators, polygons are even-odd
filled and holes are unioned, so voxel models agree with rendered meshes (tests and a fuzz suite
check ≤ 5 %). `manifold-3d` is imported lazily: flat patterns, DFM, voxels, assembly checks and
`autoEnclosure` never load WASM. `manifold.js` resolves `manifold.wasm` via `import.meta.url`, which
works unchanged in Node ESM and Vite.

| module | content |
|---|---|
| `shell.ts` | EnclosureShell → Solid, face frames, pocket/outer outlines at height z |
| `sheet.ts` | sheet model shared by 3D, flat pattern and DFM; `flatPattern` |
| `csg.ts`, `purchased.ts`, `fastener.ts` | custom CSG, envelopes/fans, procedural fastener meshes |
| `export.ts`, `massprops.ts` | STL, 3MF (stored zip), DXF R12; volume/mass/centroid/inertia |
| `voxel.ts`, `airflow.ts`, `world.ts` | voxelisers, airflow domain, assembly world model |
| `dfm-mold.ts`, `dfm-sheet.ts`, `assembly.ts` | design-rule checks |
| `auto-enclosure.ts`, `cost.ts` | enclosure generator, cost models |

## Frames and conventions

### Enclosure shell (`EnclosureShell`)
* Frame: X/Y centred on the outer footprint, `z = 0` outer floor surface, inner floor at `z = wall`
  (floor thickness = wall), open rim at `z = outer.height`. `outer.width/depth` is the outline **at
  the rim**.
* **Draft** is modelled (disable with `processOptions.draftGeometry: false`): every wall surface
  tapers inward toward the floor by `tan(draftDeg)` per mm, so walls stay uniformly thick and the part
  releases along +Z (cavity side −Z, core side +Z). Outer corner radius `cornerRadius`, inner
  `cornerRadius − wall` (≥ 0). `processOptions.innerFillet` adds a floor-to-wall fillet.
* **Face (u, v)** per core docs: `±x` → u = local Y, v = local Z; `±y` → u = local X, v = local Z;
  `floor` → u = X, v = Y; absolute coordinates, no mirroring. Cutouts/vents/catch windows are cut
  through the wall along the face normal (depth accounts for corners, draft and fillet). Cutouts
  reaching above the rim become open notches. Shapes: `rect`; `rounded-rect` (radius default
  0.25·min(w, h)); `circle` (diameter = `width`); `slot` (stadium w × h).
* **Vents**: `count` stadium slots, `slotLength` along `orientation`, stacked at `pitch` across it,
  centred on (u, v).
* **lip**: ring on the rim flush with the inner wall face, `thickness` outward, `height` above the
  rim. **groove**: rebate cut into the inner edge of the rim, `thickness` × `height`. A groove of
  lip + clearance receives the mating lip; the outer part of both rims touch.
* **Bosses**: cylinder from the inner floor up `height`. The hole runs from the boss top to the
  inner floor (blind) or through the floor (`throughFloor`) with an outside counterbore of
  Ø(head + 0.6) × (head height + 0.3) from the fastener spec (`fastenerPartId` resolved through
  `ctx.project`), else Ø2·hole × (0.6·hole + 0.4); flat heads get a 90° countersink. `gussets` =
  N triangular ribs (0.6·wall thick, 0.8·height tall at the boss, starting at +X). `pin` bosses are
  solid. Bosses/ribs are clipped to the outer envelope.
* **Snaps**: `hook` = cantilever `thickness` × `width`, inside the wall at the face, rising `length`
  above the rim; hook protrudes `overhang` outward, height hh = clamp(2·overhang, 1, 0.5·length),
  flat retaining face toward the rim, ramp to the tip. `catch` = window through the wall at
  v ∈ [H − length − 0.3, H − length + hh + 0.3], width + 0.5 — i.e. where the hook of the mating
  shell (rotated 180° about X onto this rim) engages.
* **Two-part enclosures**: the cover's instance is `rotation [180, 0, 0]`, `position [0, 0, Hb + Hc]`,
  so assembly (x, y, z) = (x, −y, Hb + Hc − z_cover): base face `+y` ↔ cover `−y`, `±x` stay, cover
  `u` on ±x faces is −y.

### Sheet metal (`SheetMetalPart`)
* Base rectangle centred, `z ∈ [0, t]`. **Base edges are outer virtual sharps**: for a 90° flange on
  `+x` the flange's outer face lies at x = +width/2, so outside dimensions = base dimensions.
* Flange `length` L = distance along the flange's outer surface from the outer virtual sharp
  (intersection of parent and flange outer surfaces) to the free edge (= outside height at 90°).
* Angle sign: positive bends toward the side continuing the base's top (+Z) surface. Base flanges
  bend up; a positive nested `far` flange on an up-flange returns toward the interior (C-channel),
  negative turns outward (hat/Z).
* Bend: inside radius r (`bendRadius` override), outer setback OSSB = (r + t)·tan(|θ|/2), bend
  allowance **BA = π/180·|θ|·(r + K·t)**, bend deduction BD = 2·OSSB − BA. Flat length =
  Σ straight lengths + Σ BA = Σ outer lengths − Σ BD (tested).
* Flange width defaults to the available edge: full edge minus (adjacent OSSB + corner gap) where
  the adjacent edge also has a flange; flanged corners are notched (corner relief). Partial-width
  flanges get relief slots (width max(t, 0.5), depth OSSB + max(t, 0.5) from the edge; `obround` =
  rounded end; `none` = no slot + DFM warning). `processOptions`: `reliefWidth`, `reliefDepth`
  (beyond the tangent line), `cornerGap`. Base `cornerRadius` rounds un-notched corners.
* Flange hole coordinates: x = u along the edge **from the flange centre** (edge midpoint +
  offset), +Y for ±x edges, +X for ±y edges (nested flanges inherit); y = v from the virtual sharp.
* Flat pattern frame = base frame (top surface toward the viewer); flanges unfold outward along their
  edge normal. `bendLines` are the bend-zone centre lines; `direction` `up` = toward the viewer.

### Custom CSG / purchased / fasteners
* `CustomPart.csg` follows core `CsgNode`: box corner at the origin unless `center`, `radius` rounds
  all edges (hull of spheres); cylinder along +Z (cone via `radiusTop`); extrude along +Z (even-odd);
  revolve (r, z) about Z; difference = first minus the rest; Euler XYZ degrees (three.js order).
* `PurchasedPart`: envelope box centred in XY, z ∈ [0, h]; with `fan`: square frame + bore
  (Ø0.94·min side), corner holes, hub, struts and 7 pitched blades; air flows along local +Z.
* `fastenerMesh(spec)`: axis Z. Screws/bolts/rivets: bearing face at z = 0, head z ∈ [−headHeight, 0],
  shank toward +Z to `length` (insertion direction = +Z). Nuts, washers, standoffs, inserts and PEMs:
  body z ∈ [0, length] (male standoff studs beyond). `FastenerInstance.position` is the bearing
  point for screws and the centre for the others — `fastenerPlacement(fi, spec)` returns the matrix.
  Missing dimensions use ISO-like proportions (`fastenerDims`).

## Voxel models
`VoxelGrid` per core: `cells[i + nx·(j + ny·k)]`, origin = min corner of cell (0,0,0); a cell is solid
when its **centre** is inside. `voxelizeMesh` ray-casts each column along +Z with three jittered rays,
accumulates a winding number from triangle orientation and takes a 2-of-3 vote (robust to coincident
or overlapping closed shells). Part/assembly voxelisers sample the Solid IR exactly.

`voxelizeForStructural(project, partIds, h)`: one part in its local frame, or several parts placed by
all their assembly instances; `materials[v−1]` = `effectiveMaterial(materialId, process, options)`,
`tags[q]` = 1 + index into `tagNames` (instance names); overlaps are reported in `warnings`.

`voxelizeAssemblyForAirflow(project, { h, boardMeshesFallback })` — modelling contract:
* domain = union bbox of all enclosure shells **+ 1 cell padding** (h default max(1, maxDim/60));
  `ambientLayer: false` drops the padding so wall cells form the domain boundary (use the solver's
  external convection coefficient there);
* solids: shells (process-adjusted material), other mechanical parts, boards as FR-4 slabs of their
  outline (minus holes/cutouts), component bodies as `epoxy-mold` blocks (model3d bbox → body →
  courtyard × bodyH) on the correct side; fans contribute only their frame;
* `openings[0]` = `ambient`: all air outside the enclosure envelope (padding layer, around rounded
  corners) — fixed ambient T/p cells. Then one entry per cutout / vent / catch window: the air cells
  of that hole that are face-adjacent to ambient cells, with outward `normal`, true `openAreaMm2`
  and `porosity` (true area / resolved area): openings narrower than a voxel are carved one voxel
  wide so they are never lost — scale their flow by `porosity`;
* `inside` mask, `componentCells` (≥ 1 cell each, heat sources never lost), `fans` (bore cells,
  local +Z in the assembly frame, free-air `flowM3s`, `maxPressurePa` for the fan curve).
  `boardMeshesFallback: false` omits boards/components.

## DFM rules

### Injection molding — `checkMoldability(shell | custom)`
| rule | check | source |
|---|---|---|
| wall | `material.molding.minWall ≤ wall ≤ maxWall`, info if > 35 % from nominal | resin data sheets; Protolabs / Xometry molding guides |
| draft | draftDeg ≥ minDraft + 1° per 0.025 mm texture depth (Mold-Tech MT-11000…11050 table, SPI A–D, VDI 3400 ≈ 10·Ra, unknown codes 0.0375 mm); 0° = error | Mold-Tech texture/draft guidance |
| ribs | t ≤ ribRatio·wall (sink), t ≥ max(0.5, 0.4·wall), h ≤ 3·wall, parallel spacing ≥ 2·wall | Protolabs, GE/SABIC & Bayer design guides |
| bosses | OD/hole 2–2.5 (crack risk < 2), boss wall ≤ 0.75·wall (info) / ≤ 1.25·wall (warning; a through-floor counterbore hollows the junction), height ≤ 3·OD without gussets, not merged into side walls (centre ≥ OD/2 + 0.25·wall above the fillet), counterbore must fit | same + insert makers (Spirol, PEM) |
| corners | inner radius (cornerRadius − wall) ≥ 0.5·wall; floor fillet ≥ 0.5·wall (info) | — |
| openings | ≥ 1·wall from corners, inner floor, rim and each other; vent web (pitch − slot) ≥ wall; closed side openings ⇒ one **side action** per face (+$1.5–5k), open-to-rim notches need none | Protolabs (side actions, shut-offs) |
| snaps | ε = 1.5·t·y/L² ≤ allowable (≈ 0.5 × strain at yield: ABS 2.5 %, PC 4 %, PC/ABS 2.5 %, PA66 4 %, POM/PP 6 %, GF grades 1.25–1.5 %; unknown 0.25 × elongation); hooks are undercuts (lifter) | Bayer/Covestro “Snap-Fit Joints for Plastics”, BASF snap-fit manual |
| flow | flow length (centre gate: half diagonal + height; edge gate: diagonal + height, ÷√gates) / wall ≤ flowRatio | resin flow data |
| lip/groove | wall beside the groove ≥ minWall; lip ≥ 0.6 mm | — |
| shrinkage | info with the resin shrinkage | data sheets |

Custom CSG parts: thick solid primitives, box-minus-box wall thickness/uniformity, missing draft
(`processOptions.draftDeg`), sharp corners.

### Sheet metal — `checkSheetMetal(part, { project })`
| rule | check |
|---|---|
| gauge | thickness in `material.sheet.gauges` (±0.01) |
| bend radius | r ≥ minBendRadiusFactor·t (error); r > 8t springback info |
| flange length | L ≥ max(4t, 2.5t + r) |
| hole size | ≥ t (1.2t stainless) |
| hole to edge | ≥ 1.5t (2t slots/rects) to the nearest free edge |
| hole to bend | ≥ 2.5t + r to the inside face of the bend (tangent line + r·tan(θ/2)); holes in the bend zone = error |
| reliefs | needed for partial flanges; width ≥ t, depth ≥ r + t |
| flat size | fits 1220 × 2440 |
| K-factor | 0.25–0.5; info if far from the material value |
| PEM | type/thread from part id (`S-`, `FH-`, `SO-` …) or FastenerSpec; min sheet, mounting hole Ø (+0.08), centre-to-edge distance; 400-series hardware in stainless (approximate PennEngineering bulletin values) |

Sources: Protolabs/Xometry/SendCutSend sheet-metal guides, Machinery's Handbook (bend allowance),
PennEngineering PEM bulletins, ISO 273 (clearance holes), EJOT PT/DELTA PT (pilot ≈ 0.8·d).

## Assembly checks — `checkAssembly(project, { meshes, resolution, minOverlapMm3, clearance })`
interference (voxel overlap over each pair's bbox intersection, 0.1–0.5 mm cells, offending board
components named), board inside its shells with ≥ 0.5 mm clearance to the drafted walls, component
clearance to every shell's inner floor/ceiling, mounting holes coaxial (≤ 0.3 mm) with a seated boss
or a standoff and a clamping fastener, edge connectors vs linked/covering cutouts (base and cover
halves merged; dedicated cutouts: centre ≤ 0.5 mm and size ≥ opening + 0.3 mm; shared openings must
contain the opening + 0.15 mm), recessed connectors, screw engagement ≥ 1.5·d (capped by the insert
length) and no bottoming in blind bosses, screw/insert bosses without a fastener. `meshes` (by
instance or part id) replaces the analytic solid of a mechanical instance.

## autoEnclosure
1. Fasteners from `fastenerPartIds` specs, else from the board hole drill (Ø3.2 → M3). Heat-set
   bosses Ø max(2.2·hole, insert + 3); thread-forming: pilot 0.8·d, OD max(2.5·pilot, 2d).
2. Boards side by side along X, or stacked on male-female standoffs when every smaller board's holes
   match the largest board's pattern.
3. Heights: standoff/boss = max(bottom parts + 1.5, insert + 0.5, screw length − board + 0.5);
   ceiling = tallest part + topClearance (and ≥ connector openings + 1 wall bridge).
4. Footprint: board bbox + clearance (+ draft compensation). Connector sides are tight: the inner wall
   sits at the receptacle face (board clearance ≥ 0.6 mm). The cheaper opposite pair of free sides is
   extended for corner case-screw bosses (insert boss on the base, counterbored clearance boss on the
   cover, 0.2 mm gap, tied to the walls by ribs); PCB bosses keep ≥ 1 mm from walls on free sides.
5. Split at the first connector's centre height so connector cutouts are open notches in both halves;
   lip 0.4·wall (if the wall allows) on the base, groove + 0.15 mm on the cover.
6. Cutouts = opening + 0.5 mm (rounded), linked to the component; overlapping openings are merged
   into one shared cutout. Vents: two connector-free side walls (low, vertical slots, web = wall —
   needs slides) and the top; `ventFaces` accepts side faces, `'top'`, `'bottom'`.
7. Instances: base identity, cover `[180, 0, 0]` at `Hb + Hc`, boards at their boss tops; fastener
   instances for screws, inserts, standoffs (`partId ''` + note when unknown). `notes` carry sizes,
   BOM and trade-offs.

## Cost — `estimateCost(part, qty, { project })`
Rough (±30–50 %) documented models in `cost.ts`: molding tooling from projected area, depth, features,
slides/lifters, steel class by quantity and cavities; unit cost from material, cooling-time-based
cycle and press rate; sheet metal from flat area, cut length, pierces, bends, PEM, finish; printing
and CNC from volume; purchased from distributor price breaks.

## Limitations
* Sheet metal: flanges only on base edges and their far edges (no side-edge flanges, hems > 175°,
  jogs, louvres, flange straight parts wider than their bend); self-intersecting flange layouts are
  not detected.
* Shell draft is applied to walls only (not to bosses/ribs); threads are not modelled.
* DFM wall analysis of custom CSG is heuristic (primitive and box-minus-box patterns).
* Interference uses voxel sampling (≥ 0.1 mm cells): touching parts are never reported; overlaps
  thinner than a cell may be missed.
