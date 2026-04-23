import logging
import os
import warnings
from datetime import datetime, timezone

import matplotlib
matplotlib.use("Agg")  # suppress GUI backend before any rocketpy import

import numpy as np
from rocketpy import Environment, Flight, Rocket, SolidMotor
from rocketpy.simulation.flight_data_exporter import FlightDataExporter

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _resolve(path: str, output_dir: str) -> str:
    """Return absolute path — if path is relative, join with output_dir."""
    if os.path.isabs(path):
        return path
    return os.path.join(output_dir, path)


def _downsample(arr: np.ndarray, max_pts: int = 500):
    """Downsample a 1-D or 2-D array to at most max_pts rows, return as list."""
    if len(arr) <= max_pts:
        return arr.tolist()
    step = len(arr) // max_pts
    return arr[::step].tolist()


def _source_cols(func_obj):
    """Return (time_array, value_array) from a RocketPy Function's .source attribute."""
    src = np.asarray(func_obj.source)
    return src[:, 0], src[:, 1]


# ---------------------------------------------------------------------------
# Core entry point
# ---------------------------------------------------------------------------

def run_rocketpy(
    params: dict,
    lat: float,
    lon: float,
    elevation: float,
    rail_length: float,
    inclination: float,
    heading: float,
    use_live_weather: bool,
    output_dir: str,
) -> dict:
    """Run RocketPy simulation from a parameters.json dict.

    User-supplied lat/lon/elevation override whatever is stored in params.

    Returns a results dict compatible with RocketPyResults / the frontend.
    """

    # ------------------------------------------------------------------
    # 1. Environment
    # ------------------------------------------------------------------
    env = Environment(latitude=lat, longitude=lon, elevation=elevation)

    weather_source = "standard_atmosphere"
    if use_live_weather:
        try:
            now = datetime.now(tz=timezone.utc)
            env.set_date((now.year, now.month, now.day, now.hour))
            env.set_atmospheric_model(type="Forecast", file="GFS")
            weather_source = "GFS"
            logger.info("Using GFS live weather forecast.")
        except Exception as exc:
            warnings.warn(
                f"GFS weather fetch failed ({exc}); falling back to standard_atmosphere.",
                RuntimeWarning,
            )
            env.set_atmospheric_model(type="standard_atmosphere")
    else:
        env.set_atmospheric_model(type="standard_atmosphere")

    # ------------------------------------------------------------------
    # 2. SolidMotor
    # ------------------------------------------------------------------
    motor_params = params["motors"][0]

    thrust_csv = _resolve(motor_params["thrust_source"], output_dir)

    motor = SolidMotor(
        thrust_source=thrust_csv,
        dry_mass=motor_params["dry_mass"],
        dry_inertia=tuple(motor_params["dry_inertia"]),
        nozzle_radius=motor_params["nozzle_radius"],
        grain_number=motor_params["grain_number"],
        grain_density=motor_params["grain_density"],
        grain_outer_radius=motor_params["grain_outer_radius"],
        grain_initial_inner_radius=motor_params["grain_initial_inner_radius"],
        grain_initial_height=motor_params["grain_initial_height"],
        grain_separation=motor_params["grain_separation"],
        grains_center_of_mass_position=motor_params["grains_center_of_mass_position"],
        center_of_dry_mass_position=motor_params["center_of_dry_mass_position"],
    )

    # ------------------------------------------------------------------
    # 3. Rocket
    # ------------------------------------------------------------------
    rkt_params = params["rocket"]

    power_off_drag = _resolve(rkt_params["power_off_drag"], output_dir)
    power_on_drag = _resolve(rkt_params["power_on_drag"], output_dir)

    rocket = Rocket(
        radius=rkt_params["radius"],
        mass=rkt_params["mass"],
        inertia=tuple(rkt_params["inertia"]),
        power_off_drag=power_off_drag,
        power_on_drag=power_on_drag,
        center_of_mass_without_motor=rkt_params["center_of_mass_without_motor"],
    )

    # Motor
    rocket.add_motor(motor, position=rkt_params["motor_position"])

    # Nosecones
    for nc in params.get("nosecones", []):
        rocket.add_nose(
            length=nc["length"],
            kind=nc.get("shape", "ogive"),
            position=nc["position"],
            base_radius=nc.get("base_radius"),
        )

    # Trapezoidal fins
    for fin in params.get("trapezoidal_fins", []):
        rocket.add_trapezoidal_fins(
            n=fin["n"],
            root_chord=fin["root_chord"],
            tip_chord=fin["tip_chord"],
            span=fin["span"],
            position=fin["position"],
        )

    # Tails (optional)
    for tail in params.get("tails", []):
        rocket.add_tail(
            top_radius=tail["top_radius"],
            bottom_radius=tail["bottom_radius"],
            length=tail["length"],
            position=tail["position"],
        )

    # Parachutes
    for chute in params.get("parachutes", []):
        trigger_raw = chute["trigger"]
        # Resolve trigger: "apogee" string or a numeric value
        if isinstance(trigger_raw, str):
            try:
                trigger = float(trigger_raw)
            except ValueError:
                trigger = trigger_raw.lower()  # e.g. "apogee"
        else:
            trigger = float(trigger_raw)

        rocket.add_parachute(
            name=chute["name"],
            cd_s=chute["cd_s"],
            trigger=trigger,
        )

    # Rail buttons
    for rb in params.get("rail_buttons", []):
        rocket.set_rail_buttons(
            upper_button_position=rb["upper_position"],
            lower_button_position=rb["lower_position"],
        )

    # ------------------------------------------------------------------
    # 4. Flight
    # ------------------------------------------------------------------
    flight = Flight(
        rocket=rocket,
        environment=env,
        rail_length=rail_length,
        inclination=inclination,
        heading=heading,
    )

    # ------------------------------------------------------------------
    # 5. Scalar results
    # ------------------------------------------------------------------
    apogee_m_asl = float(flight.apogee)
    apogee_m_agl = apogee_m_asl - elevation
    apogee_time_s = float(flight.apogee_time)
    max_speed_ms = float(flight.max_speed)
    max_mach = float(flight.max_mach_number)
    max_acceleration_ms2 = float(flight.max_acceleration)
    out_of_rail_velocity = float(flight.out_of_rail_velocity)
    burn_out_time_s = float(motor_params["burn_time"])

    # Static margin at t=0
    try:
        static_margin_cal = float(flight.static_margin(0))
    except Exception:
        static_margin_cal = 0.0

    # ------------------------------------------------------------------
    # 6. Timeseries (downsampled to ≤500 pts)
    # ------------------------------------------------------------------
    alt_t, alt_v = _source_cols(flight.altitude)
    spd_t, spd_v = _source_cols(flight.speed)
    mach_t, mach_v = _source_cols(flight.mach_number)

    # Use altitude time axis as the canonical time vector
    time_arr = alt_t
    n = len(time_arr)

    # Stability — try .source first, fall back to scalar broadcast
    try:
        _, stab_v = _source_cols(flight.static_margin)
        # Resample to match altitude time axis if sizes differ
        if len(stab_v) != n:
            stab_v = np.interp(time_arr, _source_cols(flight.static_margin)[0], stab_v)
    except Exception:
        stab_v = np.full(n, static_margin_cal)

    # Thrust — from motor Function
    try:
        thrust_t, thrust_v = _source_cols(motor.thrust)
        thrust_resampled = np.interp(time_arr, thrust_t, thrust_v, left=0.0, right=0.0)
    except Exception:
        thrust_resampled = np.zeros(n)

    # Velocity — resample to altitude time axis
    try:
        vel_resampled = np.interp(time_arr, spd_t, spd_v)
    except Exception:
        vel_resampled = np.zeros(n)

    try:
        mach_resampled = np.interp(time_arr, mach_t, mach_v)
    except Exception:
        mach_resampled = np.zeros(n)

    # Build downsampled lists
    step = max(1, n // 500)
    idx = np.arange(0, n, step)

    timeseries = {
        "time": time_arr[idx].tolist(),
        "altitude": alt_v[idx].tolist(),
        "velocity": vel_resampled[idx].tolist(),
        "mach": mach_resampled[idx].tolist(),
        "stability": stab_v[idx].tolist(),
        "thrust": thrust_resampled[idx].tolist(),
    }

    # ------------------------------------------------------------------
    # 7. 3-D trajectory (downsampled)
    # ------------------------------------------------------------------
    try:
        x_src = np.asarray(flight.x.source)
        y_src = np.asarray(flight.y.source)
        z_src = np.asarray(flight.z.source)
        traj_t = x_src[:, 0]
        traj_x = x_src[:, 1]  # East
        traj_y = y_src[:, 1]  # North
        traj_z = z_src[:, 1]  # Up

        m = len(traj_t)
        t_step = max(1, m // 500)
        t_idx = np.arange(0, m, t_step)

        trajectory_3d = {
            "t": traj_t[t_idx].tolist(),
            "x": traj_x[t_idx].tolist(),
            "y": traj_y[t_idx].tolist(),
            "z": traj_z[t_idx].tolist(),
        }
    except Exception as exc:
        logger.warning("Could not extract 3-D trajectory: %s", exc)
        trajectory_3d = {"t": [], "x": [], "y": [], "z": []}

    # ------------------------------------------------------------------
    # 8. KML export
    # ------------------------------------------------------------------
    kml_path = os.path.join(output_dir, "trajectory.kml")
    try:
        FlightDataExporter(flight).export_kml(
            file_name=kml_path,
            extrude=True,
            altitude_mode="absolute",
        )
        logger.info("KML exported to %s", kml_path)
    except Exception as exc:
        logger.warning("KML export failed: %s", exc)

    # ------------------------------------------------------------------
    # 9. Return
    # ------------------------------------------------------------------
    return {
        "apogee_m_asl": apogee_m_asl,
        "apogee_m_agl": apogee_m_agl,
        "apogee_time_s": apogee_time_s,
        "max_speed_ms": max_speed_ms,
        "max_mach": max_mach,
        "max_acceleration_ms2": max_acceleration_ms2,
        "out_of_rail_velocity": out_of_rail_velocity,
        "static_margin_cal": static_margin_cal,
        "burn_out_time_s": burn_out_time_s,
        "timeseries": timeseries,
        "trajectory_3d": trajectory_3d,
        "weather_source": weather_source,
    }
