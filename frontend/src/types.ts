export interface TimeSeriesData {
  time: number[];
  altitude: number[];
  velocity: number[];
  mach: number[];
  stability: number[];
  thrust: number[];
}

export interface Trajectory3D {
  t: number[];
  x: number[];
  y: number[];
  z: number[];
  ux?: number[];
  uy?: number[];
  uz?: number[];
}

export interface ORResults {
  apogee_m_agl?: number;
  max_velocity_ms?: number;
  max_mach?: number;
  max_acceleration_ms2?: number;
  time_to_apogee_s?: number;
  velocity_off_rail_ms?: number;
  stability_margin_cal?: number;
  timeseries?: TimeSeriesData;
}

export interface RocketPyResults {
  apogee_m_asl: number;
  apogee_m_agl: number;
  apogee_time_s: number;
  max_speed_ms: number;
  max_mach: number;
  max_acceleration_ms2: number;
  out_of_rail_velocity: number;
  static_margin_cal: number;
  static_margin_pct: number;
  burn_out_time_s: number;
  weather_source: string;
  timeseries: TimeSeriesData;
  trajectory_3d: Trajectory3D;
}

export interface RocketParams {
  motor_designation: string;
  length_m: number;
  diameter_m: number;
  wet_mass_kg: number;
  dry_mass_kg: number;
  propellant_mass_kg: number;
  motor_dry_mass_kg: number;
  fin_count: number;
  parachute_count: number;
}

export interface ComparisonResponse {
  or_results: ORResults;
  rocketpy_results: RocketPyResults;
  kml_available: boolean;
  rocket_params?: RocketParams;
  rocket_diagram?: string;
}
