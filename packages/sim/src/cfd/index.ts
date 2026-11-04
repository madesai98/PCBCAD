/**
 * Coarse voxel CFD: steady laminar airflow with Boussinesq buoyancy and conjugate heat transfer.
 * See README.md in this folder for methods, assumptions and accuracy limits.
 */
export { solveAirflow } from './airflow';
export type { AirflowSetup, AirflowResultDetail, AirflowHeatSource, AirflowOpening, AirflowFan } from './types';
