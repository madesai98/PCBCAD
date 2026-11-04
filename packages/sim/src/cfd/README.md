# Coarse voxel CFD with conjugate heat transfer (`@pcbcad/sim` → `cfd/`)

Steady, laminar, incompressible airflow with Boussinesq buoyancy and conjugate heat transfer on the
core `VoxelGrid` (0 = air, ≥ 1 = solid material index). Intended for **enclosure thermal screening**:
which components run hot, whether vents/fans move enough air, where the hot air goes. It is a coarse
engineering tool, not a certified CFD code — see the accuracy limits below.

## API

```ts
solveAirflow(setup: AirflowSetup): AirflowResultDetail   // AirflowResult + fans, residuals, air, warnings, …
```

* `heatSources[].cells` (normally solid cells of the component) share `power` (W) equally.
* `openings[].cells` are air cells connected to ambient (on the domain boundary or in wall cut-outs).
* `fans[]`: air cells of the fan; without `maxPressurePa` the flow (m³/s) is imposed along the dominant
  axis of `direction` on the downstream face of every fan cell (face velocity = flow / projected area).
* `externalH` (default 10 W/m²K, convection + radiation) applies to solid cells on the outer domain
  boundary **and to solid faces touching cells of an opening with `kind: 'ambient'`** (the outside-air
  padding layer produced by `@pcbcad/mech` `voxelizeAssemblyForAirflow`, whose `openings[0]` is that
  layer). Air cells on the domain boundary that are not openings are adiabatic no-slip walls.
* `openings[].porosity` (true open area / resolved area, e.g. sub-voxel vent slots carved one voxel wide)
  adds a Borda–Carnot loss Δp = ½ρK u², K = (1/(0.62 φ) − 1)², on the faces through which air enters or
  leaves that opening (Newton-linearised in the momentum equation). Other fields of the mech opening
  objects (`normal`, `openAreaMm2`, …) are accepted and ignored.
* `fans[].maxPressurePa` (> 0) switches the fan from a fixed flow to a linear fan curve
  Δp = p_max (1 − Q/flowM3s), applied as a pressure-jump source on the fan faces, so the operating point
  follows the system resistance. `result.fans` reports each fan's flow and static pressure rise.
* Result: `temperature` (°C per cell), `velocity` (cell-centred m/s xyz), `streamlines` (≤ 40 polylines,
  mm), `components` (max temperature over each source's cells), `vents` (net flow per opening plus
  `inM3s`/`outM3s`/`heatW`), `heatBalance` {input, vents (advected out relative to ambient), walls (through
  `externalH`)}, `iterations`, `converged`, `residuals`, `warnings`.

## Method

* **Grid** – staggered MAC grid on the voxels: pressure/temperature at cell centres, velocity components on
  cell faces; face states: wall (any solid neighbour or closed boundary), active, fixed (fan), free (inside an
  opening reservoir).
* **Momentum** – SIMPLEC (α_u = 0.7, α_p = 1), first-order upwind convection with full physical diffusion
  (hybrid differencing can make the equation degenerate next to zero-gradient opening reservoirs), no-slip
  half-cell wall shear at solid faces, Boussinesq source −ρβ(T−T_amb)g with β = 1/(T_amb+273.15). One
  forward + one backward Gauss–Seidel sweep per component per outer iteration.
* **Pressure correction** – SIMPLEC pressure equation solved with geometric-aggregation-AMG preconditioned CG
  to 10 % per outer iteration. Openings are p = 0 (ambient hydrostatic) Dirichlet reservoirs; sealed air
  regions get one reference cell.
* **Energy** – conservative finite volumes over all cells: hybrid upwind/central advection in air,
  harmonic-mean conductances (conjugate air/solid interfaces), volumetric sources, `externalH` in series
  with half a cell of solid at boundary solids. Opening cells exchange with ambient through a virtual face
  (hybrid differencing of the cell's net ambient mass exchange with half a cell of still-air conduction):
  inflow enters at ambient temperature, outflow leaves with the cell temperature (zero gradient), and
  without flow the opening still conducts to ambient. Solved every outer iteration with warm-started
  AMG-preconditioned BiCGSTAB (relative residual 3e-4, monotone AMG-cycle fallback) and relaxed with
  α_T = 0.5. (Stationary AMG cycles alone were 10–40× slower to converge the coupled problem; full
  per-iteration energy solves are what make buoyancy-driven cases converge in tens to hundreds of
  iterations.)
* **Convergence** – stop when the normalised momentum residual and continuity residual are < 1e-4 and the
  remaining temperature drift, extrapolated from the observed geometric decay of the per-iteration change,
  is < 0.1 % of the temperature rise, for 3 consecutive iterations (default limit 1000 iterations).
* **Final step** – an exact projection (pressure correction to 1e-10) makes all face fluxes
  divergence-free and a final tight energy solve (1e-10) follows, so vent flows balance and
  `input = vents + walls` to round-off even when the flow iteration is stopped early.
* **Mode** – `forced` when a fan with non-zero flow is present, else `natural`.
* **Streamlines** – fixed-step (½ cell) midpoint integration of the normalised, trilinearly interpolated
  staggered velocity; seeds at inflowing opening cells, fan cells and the hottest air next to heat
  sources (traced up- and downstream); stop in solids, at the boundary or in stagnant air.

## Validation (unit tests, `airflow.test.ts`; Node 22, one core)

| case | result |
|---|---|
| solid Al cube, uniform 2 W, h_ext = 12 W/m²K | T within 1 % of the lumped Q/(hA) |
| sealed 100 mm ABS box (5 mm cells), 1 W Al block | walls = input to 1e-11 W; plume rises; 98 iterations, 1.3 s |
| heated vertical duct 40×40×200 mm, open both ends | inflow bottom / outflow top, in = out exactly, 120.8 cm³/s at 1 W; 67 iterations |
| fan duct, 1e-4 m³/s | inlet = outlet = fan flow (to 1e-12); 41 iterations |
| 60×40×25 vented enclosure (60 k cells, 3 W, natural convection) | 324 iterations, ≈ 19 s; 60 cm³/s chimney flow in low / out high |
| sealed box inside a 1-cell `kind: 'ambient'` air layer vs walls on the boundary | source temperature within 2 % |
| chimney vents with porosity 0.1 | flow throttled (121 → 15 cm³/s), in = out |
| fan with a 2 Pa / 2e-4 m³/s linear curve, free vs throttled duct | operating point on the curve within 0.25 Pa |

Grid-convergence of the coarse solution is **not** implied by these tests; they check conservation,
boundary-condition logic and robustness.

## Accuracy limits (read before trusting a number)

* **Grid resolution.** Boundary layers are not resolved: on a solid face the air-side heat transfer is
  essentially conduction across half a cell (≈ 2k/h ≈ 10 W/m²K at 5 mm, 26 W/m²K at 2 mm) plus the resolved
  advection. Component temperatures are therefore grid dependent — use h ≤ 2 mm around hot parts and compare
  designs at the same resolution. There are no wall functions.
* **Laminar, steady.** No turbulence model (fine for natural convection in small enclosures, crude for fans
  with jets). Plumes that are physically unsteady may not converge; the result is then the last iterate
  (`converged: false`, with a warning) but the reported heat balance is still conservative.
* **Physics left out:** internal radiation between surfaces (often 30–50 % of the heat transfer in sealed
  natural-convection enclosures — temperatures are conservative/high), anisotropic conductivity (PCB copper
  spreading: give boards an effective in-plane k, e.g. 10–40 W/mK), temperature-dependent air properties
  (evaluated at ambient), fan curves (fixed flow, no pressure/flow operating point), vent pressure losses
  beyond the resolved geometry, contact resistances.
* Openings are ambient reservoirs at p = 0; inflow enters at ambient temperature without entrance loss
  unless a `porosity` is given.
