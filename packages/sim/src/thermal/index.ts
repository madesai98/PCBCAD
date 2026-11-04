/**
 * PCB thermal simulation and trace current / IR-drop analysis.
 * See ./README.md for the physical model, assumptions and accuracy limits.
 */
export { computeTraceCurrents } from './traceCurrents';
export type { TraceCurrentOptions, TraceCurrentResult, TraceSegmentReport, SegmentPower } from './traceCurrents';
export { simulatePcbThermal } from './pcbThermal';
export type { PcbThermalOptions, PcbThermalReport, PcbThermalComponentReport } from './pcbThermal';
export { ipc2221Capacity, ipc2221TempRise, IPC2221_K_EXTERNAL, IPC2221_K_INTERNAL } from './ipc';
