import type { Board, Interconnect } from './board';
import type { Assembly, MechPart } from './mech';
import type { PartDef } from './part';
import type { BehaviorScript, DesignIssue, FirmwareImage, SimulationRun } from './sim';

export interface DesignNote {
  id: string;
  at: string;
  author: 'agent' | 'user' | 'system';
  /** Short title, e.g. "Chose AMS1117-3.3 LDO". */
  title: string;
  text: string;
  tags?: string[];
}

export interface ActivityEntry {
  id: string;
  at: string;
  actor: 'agent' | 'user' | 'system';
  /** Operation / tool name, e.g. 'add_component'. */
  op: string;
  /** Human-readable summary, e.g. "Added U1 ATMEGA328P-AU to Main board". */
  summary: string;
  threadId?: string;
}

export interface ProjectSettings {
  /** Ambient temperature for simulations (°C). */
  ambientC: number;
  currency: 'USD';
  /** Production quantity used for BOM costing. */
  buildQuantity: number;
}

export interface Project {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  /** Monotonic revision, incremented on every change. */
  revision: number;
  requirements: string[];
  /** Part library used by this project, keyed by PartDef.id. */
  parts: Record<string, PartDef>;
  boards: Board[];
  interconnects: Interconnect[];
  mechanical: MechPart[];
  assembly: Assembly;
  firmware: FirmwareImage[];
  behaviors: BehaviorScript[];
  simulations: SimulationRun[];
  /** Latest results of DRC / ERC / DFM / assembly checks. */
  issues: DesignIssue[];
  notes: DesignNote[];
  activity: ActivityEntry[];
  settings: ProjectSettings;
}

/** Lightweight listing entry. */
export interface ProjectSummary {
  id: string;
  name: string;
  description: string;
  updatedAt: string;
  boards: number;
  components: number;
  mechanical: number;
}
