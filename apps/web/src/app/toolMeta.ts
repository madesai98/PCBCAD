import {
  Activity,
  ArrowDownToLine,
  Binary,
  Box,
  Boxes,
  Cable,
  CircuitBoard,
  ClipboardList,
  Cpu,
  DollarSign,
  Download,
  FileCode,
  FileSearch,
  Globe,
  Grid3x3,
  Hammer,
  Info,
  Layers,
  ListChecks,
  Move,
  Package,
  PackagePlus,
  Plug,
  Route,
  Ruler,
  Search,
  ShieldCheck,
  Shapes,
  StickyNote,
  Terminal,
  Thermometer,
  Wind,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';

interface ToolInfo {
  title: string;
  icon: LucideIcon;
  tone: 'parts' | 'schematic' | 'layout' | 'mech' | 'sim' | 'fw' | 'export' | 'info' | 'ext';
}

const T: Record<string, ToolInfo> = {
  get_design_overview: { title: 'Reviewed design', icon: ClipboardList, tone: 'info' },
  set_project_info: { title: 'Set requirements', icon: StickyNote, tone: 'info' },
  add_design_note: { title: 'Design note', icon: StickyNote, tone: 'info' },
  get_issues: { title: 'Checked issues', icon: ListChecks, tone: 'info' },
  search_parts: { title: 'Searched parts', icon: Search, tone: 'parts' },
  import_part: { title: 'Imported part', icon: PackagePlus, tone: 'parts' },
  get_part: { title: 'Read part', icon: Package, tone: 'parts' },
  define_part: { title: 'Defined part', icon: Package, tone: 'parts' },
  configure_connector: { title: 'Configured connector', icon: Plug, tone: 'parts' },
  list_fasteners: { title: 'Fastener catalog', icon: Wrench, tone: 'parts' },
  create_board: { title: 'Created board', icon: CircuitBoard, tone: 'schematic' },
  update_board: { title: 'Updated board', icon: CircuitBoard, tone: 'schematic' },
  add_components: { title: 'Added components', icon: Cpu, tone: 'schematic' },
  update_component: { title: 'Updated component', icon: Cpu, tone: 'schematic' },
  remove_components: { title: 'Removed components', icon: Cpu, tone: 'schematic' },
  connect: { title: 'Wired nets', icon: Zap, tone: 'schematic' },
  set_external_supply: { title: 'External power input', icon: Plug, tone: 'schematic' },
  disconnect: { title: 'Disconnected pins', icon: Zap, tone: 'schematic' },
  set_net: { title: 'Net properties', icon: Zap, tone: 'schematic' },
  get_netlist: { title: 'Read netlist', icon: Zap, tone: 'schematic' },
  run_erc: { title: 'Electrical rules check', icon: ShieldCheck, tone: 'schematic' },
  auto_place: { title: 'Auto-placed', icon: Grid3x3, tone: 'layout' },
  move_components: { title: 'Moved components', icon: Move, tone: 'layout' },
  add_mounting_holes: { title: 'Mounting holes', icon: CircuitBoard, tone: 'layout' },
  auto_route: { title: 'Auto-routed', icon: Route, tone: 'layout' },
  add_trace: { title: 'Added trace', icon: Route, tone: 'layout' },
  add_via: { title: 'Added via', icon: Route, tone: 'layout' },
  clear_routing: { title: 'Cleared routing', icon: Route, tone: 'layout' },
  add_zone: { title: 'Copper pour', icon: Layers, tone: 'layout' },
  run_drc: { title: 'Design rules check', icon: ShieldCheck, tone: 'layout' },
  connect_boards: { title: 'Connected boards', icon: Cable, tone: 'schematic' },
  remove_interconnect: { title: 'Removed interconnect', icon: Cable, tone: 'schematic' },
  list_materials: { title: 'Materials', icon: Shapes, tone: 'mech' },
  create_enclosure: { title: 'Generated enclosure', icon: Box, tone: 'mech' },
  add_enclosure_shell: { title: 'Added shell', icon: Box, tone: 'mech' },
  update_mech_part: { title: 'Updated part', icon: Box, tone: 'mech' },
  add_shell_feature: { title: 'Shell feature', icon: Hammer, tone: 'mech' },
  remove_shell_feature: { title: 'Removed feature', icon: Hammer, tone: 'mech' },
  create_sheet_metal_part: { title: 'Sheet-metal part', icon: Layers, tone: 'mech' },
  create_custom_part: { title: 'Custom part', icon: Shapes, tone: 'mech' },
  place_in_assembly: { title: 'Placed in assembly', icon: Boxes, tone: 'mech' },
  add_fastener: { title: 'Added fasteners', icon: Wrench, tone: 'mech' },
  run_dfm: { title: 'Manufacturability check', icon: ShieldCheck, tone: 'mech' },
  get_flat_pattern: { title: 'Flat pattern', icon: Ruler, tone: 'mech' },
  estimate_cost: { title: 'Cost estimate', icon: DollarSign, tone: 'info' },
  simulate_circuit: { title: 'Circuit simulation', icon: Activity, tone: 'sim' },
  simulate_pcb_thermal: { title: 'PCB thermal simulation', icon: Thermometer, tone: 'sim' },
  simulate_structural: { title: 'Stress simulation', icon: Hammer, tone: 'sim' },
  simulate_drop: { title: 'Drop test', icon: ArrowDownToLine, tone: 'sim' },
  simulate_airflow: { title: 'Airflow simulation', icon: Wind, tone: 'sim' },
  list_simulations: { title: 'Listed simulations', icon: Activity, tone: 'sim' },
  get_simulation: { title: 'Read simulation', icon: Activity, tone: 'sim' },
  list_firmware: { title: 'Firmware images', icon: Binary, tone: 'fw' },
  configure_mcu: { title: 'Configured MCU', icon: Cpu, tone: 'fw' },
  get_scripting_api: { title: 'Read scripting API', icon: FileCode, tone: 'fw' },
  write_behavior_script: { title: 'Behaviour script', icon: FileCode, tone: 'fw' },
  build_firmware: { title: 'Built firmware', icon: Binary, tone: 'fw' },
  run_firmware_simulation: { title: 'Firmware simulation', icon: Terminal, tone: 'fw' },
  export_manufacturing: { title: 'Manufacturing export', icon: Download, tone: 'export' },
};

const EXT: Record<string, ToolInfo> = {
  WebSearch: { title: 'Web search', icon: Globe, tone: 'ext' },
  web_search: { title: 'Web search', icon: Globe, tone: 'ext' },
  WebFetch: { title: 'Read web page', icon: Globe, tone: 'ext' },
  Read: { title: 'Read file', icon: FileSearch, tone: 'ext' },
  Glob: { title: 'Find files', icon: FileSearch, tone: 'ext' },
  Grep: { title: 'Search files', icon: FileSearch, tone: 'ext' },
  shell: { title: 'Shell', icon: Terminal, tone: 'ext' },
};

export function toolInfo(name: string): ToolInfo {
  return T[name] ?? EXT[name] ?? { title: name.replace(/_/g, ' '), icon: Info, tone: 'ext' };
}

export const TONE_COLOR: Record<ToolInfo['tone'], string> = {
  parts: '#a78bfa',
  schematic: '#38bdf8',
  layout: '#34d399',
  mech: '#fbbf24',
  sim: '#fb7185',
  fw: '#f472b6',
  export: '#22d3ee',
  info: '#94a3b8',
  ext: '#94a3b8',
};

function str(v: unknown) {
  return typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
}

/** One-line human summary of a tool call's arguments. */
export function summarizeInput(name: string, input: unknown): string {
  const a = (input ?? {}) as Record<string, any>;
  switch (name) {
    case 'search_parts':
      return `“${a.query}”`;
    case 'import_part':
    case 'get_part':
      return str(a.id ?? a.partId);
    case 'define_part':
      return str(a.mpn ?? a.id);
    case 'create_board':
      return `${a.name} · ${a.width}×${a.height} mm`;
    case 'add_components':
      return (a.components ?? []).map((c: any) => c.ref ?? c.part).slice(0, 12).join(', ') + ((a.components?.length ?? 0) > 12 ? '…' : '');
    case 'connect':
      return (a.nets ?? []).map((n: any) => n.net).slice(0, 10).join(', ');
    case 'connect_boards':
      return `${a.a?.board}:${a.a?.ref} ↔ ${a.b?.board}:${a.b?.ref}`;
    case 'move_components':
      return (a.moves ?? []).map((m: any) => m.ref).join(', ');
    case 'auto_place':
    case 'auto_route':
    case 'run_drc':
    case 'run_erc':
    case 'simulate_pcb_thermal':
    case 'update_board':
    case 'get_netlist':
      return str(a.boardId);
    case 'add_zone':
      return `${a.net} · ${a.layer}`;
    case 'simulate_circuit':
      return `${a.analysis ?? 'op'} · ${a.target ?? 'system'}`;
    case 'simulate_drop':
      return `${a.heightM} m · ${a.orientation}`;
    case 'create_enclosure':
      return `${a.materialId ?? 'pc-abs'} · ${a.process ?? 'injection-molding'}`;
    case 'create_sheet_metal_part':
      return `${a.name} · ${a.materialId} ${a.thickness} mm`;
    case 'build_firmware':
      return str(a.name);
    case 'write_behavior_script':
      return str(a.name);
    case 'run_firmware_simulation':
      return `${a.duration ?? 1} s`;
    case 'add_design_note':
      return str(a.title);
    case 'WebSearch':
    case 'web_search':
      return str(a.query);
    case 'WebFetch':
      return str(a.url);
    case 'Read':
      return str(a.file_path ?? a.path);
    default: {
      const s = Object.entries(a)
        .filter(([, v]) => typeof v !== 'object')
        .map(([k, v]) => `${k}: ${v}`)
        .join(' · ');
      return s.length > 90 ? `${s.slice(0, 87)}…` : s;
    }
  }
}
