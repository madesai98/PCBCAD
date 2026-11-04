/**
 * PCBCAD viewers — self-contained, theme-aware React visualisation components.
 *
 *  - SchematicView   SVG schematic auto-generated from the board netlist
 *  - PcbView         Canvas2D board view (realistic / layers) with sim + DRC overlays
 *  - Assembly3D      three.js assembly (lazy-loaded) with explode / x-ray / section / sim overlays
 *  - WaveformPlot    uPlot time-domain plot (multi-axis by unit + digital lanes)
 *  - LogicAnalyzer   mixed-signal firmware run (lanes, UART, LEDs, log)
 *  - ColorLegend, MetricPill, SimSummaryCard, ThermalSummaryCard
 *  - turbo / inferno colormaps
 */
export { SchematicView, type SchematicViewProps } from './schematic/SchematicView';
export { layoutSchematic, type SchLayout } from './schematic/layout';

export { PcbView, type PcbViewProps, type PcbOverlay, type PcbHoverInfo } from './pcb/PcbView';
export { DEFAULT_PCB_LAYERS, drawPcb, type PcbLayerKey, type PcbLayerVisibility, type PcbMode, type PcbViewport, type PcbDrawState } from './pcb/draw';
export { buildPcbScene, pickPcb, type PcbScene, type PcbHit } from './pcb/scene';
export { computeRatsnest, type RatsnestEdge } from './pcb/ratsnest';

export { Assembly3D } from './three/Assembly3D';
export type { Assembly3DProps, Assembly3DSelection, Assembly3DOverlay, Assembly3DSection, GetMesh } from './three/types';

export { WaveformPlot, type WaveformPlotProps } from './plot/WaveformPlot';
export { LogicAnalyzer, type LogicAnalyzerProps } from './plot/LogicAnalyzer';

export { ColorLegend, type ColorLegendProps } from './ColorLegend';
export { MetricPill, SimSummaryCard, type MetricPillProps, type SimSummaryCardProps } from './MetricPill';
export { ThermalSummaryCard, type ThermalSummaryCardProps } from './ThermalSummaryCard';

export { turbo, inferno, colormap, colormapLUT, colormapCss, colormapGradient, type ColormapName, type RGB } from './common/colormaps';
export { useViewerTheme, readTheme, type ViewerTheme } from './common/theme';
