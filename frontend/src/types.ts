export interface TimeSeriesData {
  time: number[];
  altitude: number[];
  velocity: number[];
  mach: number[];
  stability: number[];
  thrust: number[];
  drag_coeff?: number[];
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
  stability_margin_mach03_cal?: number;
  main_descent_speed_ms?: number;
  drogue_descent_speed_ms?: number;
  timeseries?: TimeSeriesData;
  or_launch_rod_length_m?: number;
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
  static_margin_mach03_cal: number;
  static_margin_mach03_pct: number;
  cp_position_m?: number;
  cg_position_m?: number;
  burn_out_time_s: number;
  impact_velocity_ms: number;
  drift_distance_m: number;
  main_descent_speed_ms: number;
  drogue_descent_speed_ms: number;
  weather_source: string;
  timeseries: TimeSeriesData;
  trajectory_3d: Trajectory3D;
  launch_lat: number;
  launch_lon: number;
  launch_elevation_m: number;
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

export interface HourlyLanding {
  hour: string;
  lat: number;
  lon: number;
}

export interface FinSetInfo {
  index: string;
  n: number;
  root_chord: number;
  tip_chord: number;
  span: number;
  sweep_length: number;
  position: number;
  thickness?: number;
  fallback_fields: string[];
}

export interface ComparisonResponse {
  or_results: ORResults;
  rocketpy_results: RocketPyResults;
  kml_available: boolean;
  kml_data?: string;
  rocket_params?: RocketParams;
  rocket_diagram?: string;
  diagram_nose_frac?: number;
  diagram_tail_frac?: number;
  fin_comparison_diagram?: string;
  fin_sets?: FinSetInfo[];
  hourly_landings?: HourlyLanding[];
  warnings?: string[];
}
