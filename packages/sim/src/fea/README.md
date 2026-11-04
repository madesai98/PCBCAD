# Voxel structural FEA and drop screening (`@pcbcad/sim` → `fea/`)

Linear-elastic static analysis and an equivalent-static drop/impact estimate on the core `VoxelGrid`.
These are **engineering screening tools**, not certified solvers: use them to compare design options,
find weak spots and size walls/ribs/bosses, then confirm critical parts by test or a full FE package.

## API

```ts
solveStructural(setup: StructuralSetup, meta: { title; loads: string[]; fixtures: string[] }): StructuralResultDetail
solveDrop(setup: DropSetup): DropResultDetail
analyzeStructure(setup): StructuralAnalysis          // raw Float64 fields, for post-processing
buildStructuralResult(analysis, meta, scale?): StructuralResultDetail
```

`StructuralResultDetail` / `DropResultDetail` are the core `StructuralResult` / `DropResult` plus
diagnostics (`raw`, `singularityExcludedVoxels`, `appliedForce`, `bodies`, `warnings`, `wallMs`,
`stiffness`, …). Units: mm, N, MPa (stress, E), kg/m³, g (masses), m/s² (accelerations).

### Regions (`Region`)

| kind | selects | node set (fixtures / forces) | pressure faces |
|---|---|---|---|
| `box` | solid voxels with centre in `[min,max]` (fallback: voxels intersecting the box) | all 8 nodes of each voxel | all exposed faces |
| `plane` | voxels within `depth` (default h) of the extreme solid extent on `axis`/`side` | only nodes of the exposed faces facing that side (a clamped *surface*) | those faces |
| `cylinder` | voxel centres inside (centre, unit axis, radius, total length ±L/2); fallback inflates by ½ voxel diagonal | all 8 nodes | all exposed faces |
| `cells` | listed linear voxel indices (non-solid ignored) | all 8 nodes | all exposed faces |

Fixtures clamp all three displacement components. Forces are split equally over the region's nodes;
pressure (MPa) acts inward on the region's exposed faces (p·h² per face, ¼ to each corner).
`bodyAcceleration` is a body-force field (gravity = `[0,0,-9.81]`), force = ρ·V·a per voxel.
A region that selects no solid voxel throws; so does a model without fixtures.

## Method

* **Element** – 8-node cube with the 9 Wilson–Taylor incompatible bubble modes, 2×2×2 Gauss
  (exact for a cube), statically condensed: `K = E·h·K̂(ν)`. One 24×24 matrix per material. The bubbles
  remove the parasitic shear of trilinear hexes, so walls 1–2 voxels thick bend correctly (a plain
  trilinear hex is 3–5× too stiff there). Pure bending is reproduced exactly (unit test).
* **Bodies** – solid voxels are split into face-connected bodies (edge/vertex contacts are hinges and
  are *not* treated as connections). Each body is solved independently. A body with no fixture, or
  fixed only along a point/line (rotation possible), is skipped with a warning and shown with zero
  stress; if no body is properly fixed the solver throws.
* **Solver** – matrix-free element-by-element operator, preconditioned conjugate gradients
  (relative residual `‖r‖/‖f‖ ≤ tolerance`, default 1e-6). Preconditioner: geometric multigrid
  V-cycle with exact Galerkin coarse operators (trilinear prolongation on the voxel-node grid, stored
  per coarse cell and de-duplicated), clamped DOFs masked out of the transfer, 3×3-block Chebyshev
  smoothing (degree 1 on the fine level, 4 on the cheap coarse levels), dense Cholesky on the coarsest
  level (≤ 900 DOFs).
* **Stress** – σ = D·B·u with the full enhanced strain. Per voxel the reported von Mises is the maximum
  of the centroid value and the values at the centres of its exposed or material-interface faces, so
  the *surface* stress of thin walls is captured (a centroid-only value under-reads a 2-voxel wall in
  bending by ~50 %). Voxel displacement = mean of its 8 nodes; `maxDisplacement` = max nodal |u|.
* **Singularities** – idealised rigid supports and point/line loads create mesh-dependent stress peaks.
  `maxVonMises`, `minSafetyFactor` (= yield / von Mises, capped at 1000) and `maxStressAt` therefore
  **exclude voxels that touch a clamped node or a node of a concentrated force** (a force region whose
  node set spans ≤ 2 voxels in at least two axes, i.e. point- or line-like). Unfiltered values are in
  `raw`. Distributed loads (pressure, large patches) are not excluded. If every voxel would be excluded
  the raw values are reported (with a warning).

## Drop / impact (`solveDrop`)

Equivalent-static energy method (linear single-DOF spring–mass):

1. `v = √(2 g H)`; mass m = solid voxels + `extraMasses` (each applied as a force on the solid voxels
   nearest to its position, within one voxel of the nearest).
2. Impact patch clamped: the extreme voxel layer for `bottom` (−z), `top` (+z), `side-x` (−x),
   `side-y` (−y); for `corner` (−1,−1,−1)/√3 and `edge` (0,−1,−1)/√2 the voxels within
   max(1.5 h, 2 mm) of the extreme point/edge along the drop direction.
3. Unit solve with 1 g toward the floor; `k_s = m·g / (mass-weighted mean displacement along the drop
   direction)` (Rayleigh-quotient stiffness of the load path).
4. Floor contact stiffness in series (assumed): concrete 5·10⁷, wood 1·10⁷, carpet 1·10⁶ N/m.
   `k_eff = 1/(1/k_s + 1/k_f)`, `F = v√(k_eff m)`, `a = F/m`, `peakG = a/9.81`,
   `contactDurationMs = π√(m/k_eff)·1000`, `stopDistanceMm = F/k_eff·1000`.
5. Stresses = unit solution × peakG (linear).
6. Component risk (solder joint / connector retention screening heuristic): inertial force `m·a`;
   **high** if F > 40 N or (m > 2 g and peak > 1500 g), **medium** if F > 10 N or peak > 500 g.

Not modelled: rebound, rotation after a corner/edge hit, multiple impacts, plastic deformation, local
crushing of the contact zone, rate effects, separate contact of internal parts. A heavy part on a
compliant mount lowers the single-DOF stiffness (and peak force) — real transient peaks on the stiff
shell can be higher. Treat results as ±2× estimates for compact products.

## Validation (unit tests, `*.test.ts`)

| case | result |
|---|---|
| cantilever 100×10×10 steel, 100 N tip, h = 1 mm | δ = 0.20002 mm vs FL³/3EI = 0.20000 (+0.01 %), 17 PCG its |
| same, h = 2 mm | 0.19976 mm (−0.12 %), 15 its |
| surface bending stress along that span (x = 20…80 mm) | within 2 % of M·c/I |
| axial bar | σ within 2 % of F/A, δ within 3 % of FL/EA |
| thin plate 60×20×2 mm (2 voxels thick) | δ / beam theory = 0.972 (plate effect ≈ 0.91–1.0) |
| pressure on a column | σ = p within 2 %, net force = p·A exactly |
| 42 k-voxel thin-walled ABS enclosure (189 k DOFs) | ≈ 8.5 s, 78 PCG its to 1e-6 (Node 22, 1 core) |
| 80 k-voxel solid cantilever (h = 0.5 mm, 265 k DOFs) | ≈ 3.9 s, 17 PCG its |

## Accuracy limits & known issues

* Geometry is staircase-voxelised: curved surfaces, fillets and draft are approximated at ±h/2; stress
  concentrations at re-entrant corners are mesh dependent (they grow as h shrinks). Use h ≤ wall/2 for
  stress results on thin walls; displacement/stiffness converge much faster than stress.
* Isotropic linear elasticity only (anisotropic FR-4/FDM, contact, friction, bolt preload, large
  deflection, buckling, creep and plasticity are not modelled). Parts that merely touch are bonded if
  they share a voxel face. Weak-plane (knit-line / layer) strength is not checked.
* Nearly incompressible materials (ν > 0.45, e.g. TPU, silicone) may lock; a warning is emitted.
* Multigrid efficiency drops for walls only 1–2 voxels thick (the trilinear coarse spaces shear-lock in
  bending): ~15–20 PCG iterations for bulky parts, ~50–80 for thin-walled enclosures; counts are
  mesh-independent (106 vs 105 iterations at 42 k and 337 k voxels in an earlier configuration).
  A smoothed-aggregation coarse space with rotational modes would fix this.
