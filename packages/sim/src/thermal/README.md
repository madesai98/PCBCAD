# PCB thermal & trace-current engine (`@pcbcad/sim` → `thermal/`)

Steady-state board temperature field, component junction temperatures, DC current distribution
in the copper (IR drop, IPC-2221 trace loading) and the Joule heating it causes. Pure
TypeScript, no Node built-ins (runs in Node workers and in the browser).

```ts
import { simulatePcbThermal, computeTraceCurrents, ipc2221Capacity, ipc2221TempRise } from '@pcbcad/sim';

const thermal = simulatePcbThermal(project, boardId, {
  power: op.componentPower,          // component id (or ref) → W
  pinCurrents: op.pinCurrents,       // optional: component id → pin → A INTO the pin
  ambient: 25,                       // default project.settings.ambientC
  convection: { mode: 'natural' },   // or { mode: 'forced', airVelocity: 2 }, hTop/hBottom overrides
  orientation: 'horizontal',         // or 'vertical' (board +Y up)
});
const ir = computeTraceCurrents(board, project.parts, op.pinCurrents, { temperature: 40 });
ipc2221Capacity(0.254, 1, 10, true);  // ≈ 0.88 A (10 mil, 1 oz, outer, +10 °C)
```

| file | content |
| --- | --- |
| `pcbThermal.ts` | `simulatePcbThermal`: grid model, sources, outer iteration, outputs |
| `traceCurrents.ts` | `computeTraceCurrents`, island balancing, per-segment report |
| `network.ts` | per-net resistor network from traces / pads / vias / zones |
| `gridSolver.ts` | multigrid-preconditioned CG for the structured thermal system |
| `laplacian.ts` | direct (min-degree elimination) solver for resistor networks |
| `raster.ts` | copper coverage rasteriser, board mask |
| `convection.ts` | air properties, natural/forced convection, radiation |
| `packageThermal.ts` | default θJC per package family, solder-joint θcb |
| `stackup.ts`, `ipc.ts` | layer heights / copper thickness, IPC-2221 formulas |

## 1. Trace currents and IR drop (`computeTraceCurrents`)

For every net with non-zero pin current a resistor network is built:

* **Nodes**: trace vertices per layer (merged within 1 µm); one node per component pin. All pads
  with that pin number share it. A THT pad is a single node through the board, because the lead
  and solder short its barrel. Vias get one node per spanned layer. Each zone-fill island gets
  one hub node.
* **Trace segments**: `R = ρ(T)·L/(w·t)`, with `t` from `copperOz` (outer/inner) and
  `ρ(T) = 1.72e-8·(1 + 0.00393·(T − 20))` Ω·m. A segment is split wherever another trace's end
  (T-junction), a via or a pad touches it mid-way.
* **Attachment rules**: a trace end connects to a pad when it lies inside the pad polygon or
  within w/2 of its edge. It connects to a via when it overlaps the via pad. A via inside a pad
  (via-in-pad) merges with the pad.
* **Via barrels**: `R = ρ·Δz/(π·t_p·(d + t_p))` between consecutive layers. Plating
  `t_p = 25 µm`, `d` = finished drill. Layer heights are in §4.
* **Zones (star model)**: each pad, via and trace vertex inside a fill island connects to the
  island hub through the radial spreading resistance of a disc contact. Here `a` is the contact
  radius (√(pad area/π), via radius or trace half-width) and `L = √(A_island/π)`:

  `R = R□/(2π)·ln(max(2, L/a))`, with `R□ = ρ/t`

  Two contacts then see `R□/(2π)·(ln(L/a₁) + ln(L/a₂))`. That is the classical result for two
  small contacts in a sheet, with their separation replaced by L. Pads in `thermalRelief` zones
  add 4 spokes, each 0.5 mm wide and as long as the zone clearance. Each copper blob attaches
  once. Islands come from `zone.fill` (even-odd rings), else the outline, else the board outline.
* **Injection**: −I_pin at each pin node. Each connected island is solved separately, with its
  largest injector grounded, by exact sparse elimination with minimum-degree ordering.
* **Unbalanced islands** (Σ I ≠ 0, i.e. incomplete routing): the over-represented side (sources or
  sinks) is scaled down, so the routed copper carries exactly the routed pins' current. A
  warning reports the missing current once: max(Σ surplus, Σ deficit).
* **Per segment output**:
  * |I|: the largest sub-segment current when the segment is split;
  * current density in A/mm²;
  * |ΔV| between the segment's end vertices;
  * IPC-2221 `ΔT = (I/(k·A^0.725))^(1/0.44)` (A in mil², k = 0.048 external / 0.024 internal);
  * `ipcCapacity`: current at +10 °C;
  * status: `fail` above the +20 °C capacity, `warn` above +10 °C;
  * extra fields: `layer`, `width`, `length`, `resistance`, `power`, `direction`.
* **`netDrops`**: the largest potential difference between current-carrying pins (per island,
  worst island) and the net current (Σ of current entering the copper from pins).

## 2. Thermal model (`simulatePcbThermal`)

**Grid.** Uniform cells tile the outline bbox, with the default size `max(0.4, maxDim/150)` mm.
A cell is masked out when its centre lies outside the outline, inside a cutout, or inside a
mounting-hole drill.

**Nodes per cell.** A 2-layer board has a top and a bottom node. 4/6-layer boards use one of:

* `innerLayers: 'resolved'`: one node per copper layer.
* `'lumped'`: two nodes, with inner layers merged into the nearer one (the spec'd simplification).
* `'auto'` (the default): `'resolved'` unless it would exceed 400k unknowns.

Lumping assumes perfect coupling between a surface and the inner plane 0.2 mm below it. Under a
small source without thermal vias, the prepreg in between is a significant resistance, so
lumping is optimistic. Example: a 1 W QFN on a 50×50 mm 4-layer board with GND planes on
in1/in2 and no vias gives Tj = 87 °C lumped vs 124 °C resolved.

**Conductances.**

* **In-plane**, node m of a cell: `K = k_in·t_FR4,m + Σ_layers k_Cu·t_Cu·f`. Here f is the copper
  area fraction of the layer in that cell (pads, traces of their real width, vias, plated holes,
  zone fills). K uses the harmonic mean between neighbours; FR-4 (k_in = 0.8, k_z = 0.3) and
  copper (388 W/m·K) come from the materials library. In 2-node mode each node carries half of
  the board's FR-4.
* **Through-plane**: `k_z·A/Δz` between consecutive nodes (Δz = t_board in 2-node mode), plus
  `k_Cu·π·t_p·(d+t_p)/Δz` for every plated barrel in the cell. This counts vias of every net,
  THT pads and plated holes.

**Copper rasteriser.** Axis-aligned rectangles (rect/roundrect/oval pads at 0/90/180/270°,
orthogonal trace bodies, rectangular pours) are integrated exactly. Other shapes are exact in x
and sampled on 4–24 sub-rows per cell row in y. The count adapts to the narrowest trace, so the
error is at most one sub-row height per edge. Overlapping copper is unioned, never double counted.

**Boundary conditions.** The top node carries the top face, the bottom node the bottom face, and
board edges are split equally over the nodes of edge cells (`edges: 'adiabatic'` turns edges off).

* Natural convection, horizontal board, with L = A/P:
  * hot face up: Nu = 0.54 Ra^¼ (0.15 Ra^⅓ above Ra = 1e7);
  * hot face down: Nu = 0.27 Ra^¼;
  * a face cooler than the air swaps the two correlations.
* Natural convection, vertical board: Churchill–Chu with L = board height.
* Air properties are evaluated at the film temperature: Sutherland viscosity and conductivity,
  ideal-gas density.
* Forced convection: flat plate along board X. Laminar Nu = 0.664 Re^½ Pr^⅓, mixed
  laminar/turbulent `0.037 Re^0.8 − 871` above Re = 5e5. Natural convection is added as
  `(h_f³ + h_n³)^⅓`. The default `airVelocity` is 1 m/s.
* `hTop` / `hBottom` override the convective coefficient of their face.
* Radiation: ε = 0.9 (option `emissivity`), linearised per cell as
  `h_r = εσ(T² + T∞²)(T + T∞)`.
* `enclosureAirTemp` replaces ambient as both the convective and the radiative sink. Using the
  air temperature for the walls is conservative.

**Sources.**

* Component power is spread uniformly over the component's pad copper on its side (the
  courtyard when it has no pads, or the body / a 2×2 mm square when there is no footprint), into
  that side's node. Power keys accept component id or ref. Negative, DNP and unplaced entries are
  ignored with a warning.
* When `pinCurrents` is given, Joule heat I²R of every trace sub-segment, via barrel and plane
  contact is deposited along the segment or at the contact. Via heat is split between both layers.

**Solution.**

* Unknowns are the rise θ = T − T_air.
* Each outer iteration (≤ 8; typically 3–7):
  1. update h from each face's mean rise;
  2. update h_r per cell;
  3. recompute the trace currents with ρ at the local copper temperature (electro-thermal
     coupling);
  4. solve.
* Linear solves use CG preconditioned with one symmetric multigrid V-cycle:
  * 2×2 Galerkin aggregation, which keeps the 5-point + column structure on every level and
    handles masks exactly;
  * column-block Gauss–Seidel smoothing, with each cell's tridiagonal z-column solved exactly;
  * dense Cholesky on the coarsest level (≤ 400 unknowns).
* Intermediate solves stop at 1e-2 × the last outer change (≤ 1e-4); the final solve reaches a
  relative residual of 1e-8. Typical cost is 6–13 PCG iterations per solve, independent of grid
  size and copper contrast.

**Component temperatures.**

* `tBoard`: pad-weighted mean temperature of the component-side node.
* `tCase = tBoard + P·θcb`, where `θcb = 75 µm / (k_SAC305·A_pads)` is the solder joint.
* `tJunction = tCase + P·θJC`. θJC is `part.thermal.thetaJC`, else a package-family default
  (`packageThermal.ts`). The defaults are board-side θJB/θJL-like values: QFN 8, SOT-223 15,
  SOIC 40 (10 with an exposed pad), SOT-23 120, chip 0603 120, 1206 55 °C/W, and so on.
* Status uses `tjMax = thermal.tjMax ?? ratings.tempMax ?? 125`: `fail` above tjMax, `warn` above
  T_air + 0.85·(tjMax − T_air).
* When `thetaJA` is known, `T_air + P·θJA` is reported, with a warning if its rise differs from
  the model's by more than 2×.

**Outputs.**

* `layers` top and bottom (packed f32; masked cells = T_air) and `mask` (packed u8).
* `maxTemp`: the field maximum. `totalPower`: components + Joule.
* `convection`: the coefficients actually used, plus the area-mean `hRadTop/hRadBottom`.
* Diagnostics: `heatBalance` (exact σT⁴ loss vs input), `solver` statistics, `warnings`.

## 3. Validation (tests in this folder)

| check | result |
| --- | --- |
| Energy balance, recomputed independently from the output fields (convection + exact σT⁴ radiation + edges) | within 1 % (the solver's own balance: ~1e-6) |
| 1-D through-plane, uniform flux, fixed h | exact to 1e-3 K |
| Two-layer fin (heated strip, coupled 2×2 eigenmode) | decay ratios within 0.1 % (observed 0.001 %) |
| Symmetric source on a square board | mirror and 90° symmetric to < 1e-3 K |
| Single trace, I injected | identical I in every segment; ΔV = I·R within 0.5 % (observed ~1e-12) |
| Two parallel traces (w 0.5 / 1.0 mm) | 1/3 and 2/3 split |
| Via chain, T-junction, zone hub, trace ∥ zone, via-in-pad | analytic within 1e-6 |
| IPC-2221: 10 mil, 1 oz, external, +10 °C | 0.880 A |
| Natural h, 30–100 mm boards (1 W) / forced 2 m/s | top 5.7–11.4, bottom 2.8–5.6 (+ radiation 5.6–6.4) / 17.6–32.2 W/m²K |
| 4-layer without inner copper vs 2-layer (with pours) | < 1 % difference |
| Copper pour / thermal vias / inner planes | lower peak temperature, in that order of benefit |
| 100×80 mm at 0.5 mm, 2 × 32k unknowns | ≈ 0.4 s (Node 22) |

## 4. Accuracy and limits

* **Convection correlations** carry about ±25 %, the dominant uncertainty for a board in free
  air. They are used below their nominal Ra range for small boards. Real enclosures, nearby
  boards and partial shading change h. Pass measured or CFD-derived `hTop`/`hBottom` when
  available.
* **All component power enters the board.** Heat leaving through the package top (significant for
  large packages and for TO-220 without a heatsink) is ignored, which is conservative for the
  junction. θJC defaults are typical values (±50 %). Supply `part.thermal` for important parts.
* **2-node z-discretisation.** The FR-4 in-plane conduction is carried at the surface
  temperatures, which is exact for a linear through-thickness profile. Next to small sources on
  bare FR-4 it under-predicts the local rise by up to ~15 % (3×3 mm source on 1.6 mm FR-4: 249 K
  with 2 nodes vs 290 K with 6). With copper pours the 2/4/6-node results agree within 0.3 %.
* **Stackup heights are assumed.** The contract has no dielectric thicknesses. 4-layer boards use
  12.5 % prepreg / 75 % core, 6-layer boards equal spacing. Copper weight is taken as the finished
  thickness. Vias are not filled.
* **Grid**: cells are masked by their centre, so outline errors are ≤ ½ cell. Copper narrower than
  a cell is smeared over that cell, so a trace's own temperature rise is not resolved (that is
  what the IPC figures are for).
* **Zones without `fill`** use the full outline (or board outline), which overestimates copper.
  Thermal-relief geometry is used only electrically.
* **Electrical**: DC only, with ρ at the local temperature but uniform within a segment.
* **Electrical topology**: crossings of two same-net traces without a shared vertex or end are not
  connected. The zone star model is roughly ±30 % for plane resistance (exact for two contacts at
  distance ≈ √(A/π)). Current crowding at pad entries is not modelled.
* **IPC-2221** is conservative for internal layers and boards with planes (IPC-2152 gives more
  capacity). It is reported per isolated segment.
