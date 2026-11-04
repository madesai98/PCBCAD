# Coarse voxel CFD with conjugate heat transfer (`@pcbcad/sim` → `cfd/`)

Steady, laminar, incompressible airflow with Boussinesq buoyancy and conjugate heat transfer on the
core `VoxelGrid` (0 = air, ≥ 1 = solid material index). Intended for **enclosure thermal screening**:
which components run hot, whether vents/fans move enough air, where the hot air goes. It is a coarse
engineering tool, not a certified CFD code — see the accuracy limits below.

## API

```ts
solveAirflow(setup: AirflowSetup): AirflowResultDetail   // AirflowResult + residuals, air, warnings, …
airProperties(T°C)                                        // dry-air ρ, μ, k, c_p, β used by the solver
```

* `heatSources[].cells` (normally solid cells of the component) share `power` (W) equally.
* `openings[].cells` are air cells connected to ambient (on the domain boundary or in wall cut-outs).
* `fans[]`: air cells of the fan; flow (m³/s) is imposed along the dominant axis of `direction` on the
  downstream face of every fan cell (face velocity = flow / projected fan area).
* `externalH` (default 10 W/m²K, convection + radiation) applies to solid cells on the outer domain
  boundary. **Air cells on the domain boundary that are not openings are adiabatic no-slip walls**, so
  either make the enclosure walls the domain boundary or mark the outer air as openings.
* Result: `temperature` (°C per cell), `velocity` (cell-centred m/s xyz), `streamlines` (≤ 40 polylines,
  mm), `components` (max temperature over each source's cells), `vents` (net flow per opening plus
  `inM3s`/`outM3s`/`heatW`), `heatBalance` {input, vents (advected out relative to ambient), walls (through
  `externalH`)}, `iterations`, `converged`, `residuals`, `warnings`.

## Method

* **Grid** – staggered MAC grid on the voxels: pressure/temperature at cell centres, velocity components on
  cell faces; face states: wall (any solid neighbour or closed boundary), active, fixed (fan), free (inside an
  opening reservoir).
* **Momentum** – SIMPLEC (α_u = 0.7, α_p = 1), first-order upwind convection with full physical diffusion,
  no-slip half-cell wall shear at solid faces, Boussinesq source −ρβ(T−T_amb)g with β = 1/(T_amb+273.15).
  Two symmetric Gauss–Seidel sweeps per component per outer iteration.
* **Pressure correction** – SIMPLEC pressure equation solved with geometric-aggregation-AMG preconditioned CG
  to 10 % per outer iteration. Openings are p = 0 (ambient hydrostatic) Dirichlet reservoirs; sealed air
  regions get one reference cell.
* **Energy** – conservative finite volumes over all cells: hybrid upwind/central advection in air,
  harmonic-mean conductances (conjugate air/solid interfaces), volumetric sources, `externalH` in series
  with half a cell of solid at boundary solids. Opening cells take ambient-temperature inflow and let
  outflow leave with the cell temperature (zero gradient). Solved each outer iteration with warm-started
  AMG-BiCGSTAB and relaxed by α_T = 0.5; the coupled flow/energy iteration stops when the momentum and
  continuity residuals are < 1e-4 and the extrapolated remaining temperature drift is < 0.1 % of the rise.
* **Final step** – an exact projection (pressure correction to 1e-10) makes all face fluxes
  divergence-free and a final tight energy solve follows, so vent flows balance and
  `input = vents + walls` to round-off even when the flow iteration is stopped early.
* **Mode** – `forced` when a fan with non-zero flow is present, else `natural`.

## Validation (unit tests)

| case | result |
|---|---|
| solid Al cube, uniform 2 W, h_ext = 12 | T within 1 % of lumped Q/(hA) |
| sealed 100 mm ABS box, 1 W block inside | walls = input to 1e-11, buoyant plume above the block |
| heated vertical duct (chimney), open both ends | inflow at the bottom, outflow at the top, in = out (exact) |
| fan duct, 1e-4 m³/s | inlet and outlet flow = fan flow (exact), chip heat carried by the air |
| 60×40×25 vented enclosure (60 k cells) | see performance test |

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
* Openings are ambient reservoirs at p = 0; inflow enters at ambient temperature without entrance loss.
