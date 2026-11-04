import { ToolRegistry } from '../registry';
import { exportTools } from './export';
import { firmwareTools } from './firmware';
import { interconnectTools } from './interconnect';
import { layoutTools } from './layout';
import { mechTools } from './mech';
import { partTools } from './parts';
import { projectTools } from './project';
import { schematicTools } from './schematic';
import { simTools } from './sim';

export function createRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(...projectTools, ...partTools, ...schematicTools, ...layoutTools, ...interconnectTools, ...mechTools, ...simTools, ...firmwareTools, ...exportTools);
  return r;
}
