from pydantic import BaseModel
from typing import Optional

class TimeSeriesData(BaseModel):
    time: list[float]
    altitude: list[float]
    velocity: list[float]
    mach: list[float]
    stability: list[float]
    thrust: list[float]

class Trajectory3D(BaseModel):
    t: list[float]
    x: list[float]  # East (m)
    y: list[float]  # North (m)
    z: list[float]  # Up/altitude (m)
    ux: list[float] = []  # nose direction unit vector — East component
    uy: list[float] = []  # nose direction unit vector — North component
    uz: list[float] = []  # nose direction unit vector — Up component

class ORResults(BaseModel):
    apogee_m_agl: Optional[float] = None
    max_velocity_ms: Optional[float] = None
    max_mach: Optional[float] = None
    max_acceleration_ms2: Optional[float] = None
    time_to_apogee_s: Optional[float] = None
    velocity_off_rail_ms: Optional[float] = None
    stability_margin_cal: Optional[float] = None
    stability_margin_mach03_cal: Optional[float] = None
    main_descent_speed_ms: Optional[float] = None
    drogue_descent_speed_ms: Optional[float] = None
    timeseries: Optional[TimeSeriesData] = None
    or_launch_rod_length_m: Optional[float] = None

class RocketPyResults(BaseModel):
    apogee_m_asl: float
    apogee_m_agl: float
    apogee_time_s: float
    max_speed_ms: float
    max_mach: float
    max_acceleration_ms2: float
    out_of_rail_velocity: float
    static_margin_cal: float
    static_margin_pct: float
    static_margin_mach03_cal: float = 0.0
    static_margin_mach03_pct: float = 0.0
    burn_out_time_s: float
    impact_velocity_ms: float = 0.0
    drift_distance_m: float = 0.0
    main_descent_speed_ms: float = 0.0
    drogue_descent_speed_ms: float = 0.0
    weather_source: str = "standard_atmosphere"
    timeseries: TimeSeriesData
    trajectory_3d: Trajectory3D
    launch_lat: float = 0.0
    launch_lon: float = 0.0
    launch_elevation_m: float = 0.0

class RocketParams(BaseModel):
    motor_designation: str = ""
    length_m: float = 0.0
    diameter_m: float = 0.0
    wet_mass_kg: float = 0.0
    dry_mass_kg: float = 0.0
    propellant_mass_kg: float = 0.0
    motor_dry_mass_kg: float = 0.0
    fin_count: int = 0
    parachute_count: int = 0

class HourlyLanding(BaseModel):
    hour: str   # ISO datetime, e.g. "2026-04-27T18:00"
    lat: float
    lon: float

class FinSetInfo(BaseModel):
    index: str
    n: int
    root_chord: float
    tip_chord: float
    span: float
    sweep_length: float = 0
    position: float = 0
    fallback_fields: list[str] = []

class ComparisonResponse(BaseModel):
    or_results: ORResults
    rocketpy_results: RocketPyResults
    kml_available: bool = False
    kml_data: Optional[str] = None
    rocket_params: Optional[RocketParams] = None
    rocket_diagram: Optional[str] = None
    fin_comparison_diagram: Optional[str] = None
    fin_sets: list[FinSetInfo] = []
    hourly_landings: list[HourlyLanding] = []
    warnings: list[str] = []
