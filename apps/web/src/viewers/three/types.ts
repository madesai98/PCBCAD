import type { AirflowResult, MeshData, PcbThermalResult, Project, StructuralResult } from '@pcbcad/core';

/** Async mesh provider: `mech:<partId>`, `fastener:<partId>`, or a Model3D meshAssetId. */
export type GetMesh = (key: string) => Promise<MeshData | null>;

/** What a click in the 3D view selects (shape-compatible with the app's selection model). */
export type Assembly3DSelection =
  | { kind: 'mech'; partId: string; instanceId?: string }
  | { kind: 'component'; boardId: string; componentId: string }
  | { kind: 'board'; boardId: string; instanceId?: string }
  | { kind: 'part'; partId: string; fastenerId: string };

export interface Assembly3DOverlay {
  /** Voxel von Mises field (assembly frame). Parts are ghosted while shown. */
  structural?: StructuralResult;
  /** Temperature slice + streamlines (assembly frame). */
  airflow?: AirflowResult;
  /** Replaces that board's top texture with the heat map. */
  pcbThermal?: PcbThermalResult;
}

export interface Assembly3DSection {
  axis: 'x' | 'y' | 'z';
  /** Cut position along the axis in assembly coordinates (mm); geometry beyond it is removed. */
  offset: number;
}

export interface Assembly3DProps {
  project: Project;
  getMesh: GetMesh;
  /** Assembly instance id, mech part id, board id, component id or fastener id. */
  selectedId?: string | null;
  /** Method syntax on purpose: callers may accept a narrower selection union. */
  onSelect?(sel: Assembly3DSelection | null): void;
  /** 0..1 — uses AssemblyInstance.explode when set, otherwise an automatic stack/radial explode. */
  explode?: number;
  /** Enclosure parts become transparent (opacity .18). */
  xray?: boolean;
  section?: Assembly3DSection | null;
  overlay?: Assembly3DOverlay;
  showFasteners?: boolean;
  /** Built-in view toolbar (default true). */
  toolbar?: boolean;
  className?: string;
  style?: React.CSSProperties;
}
