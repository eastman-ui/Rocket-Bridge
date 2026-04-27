import logging
import os
import warnings
from datetime import datetime, timezone
from typing import Optional

import matplotlib
matplotlib.use("Agg")  # suppress GUI backend before any rocketpy import

import numpy as np
from rocketpy import Environment, Flight, Rocket, SolidMotor

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
    sim_datetime: Optional[str] = None,
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
            if sim_datetime:
                # Parse local ISO string, treat as UTC (user intent: pick a GFS run)
                from datetime import datetime as _dt
                parsed = _dt.fromisoformat(sim_datetime).replace(tzinfo=timezone.utc)
            else:
                parsed = datetime.now(tz=timezone.utc)
            # Round down to nearest 6-hour GFS run (00/06/12/18 UTC)
            gfs_hour = (parsed.hour // 6) * 6
            env.set_date((parsed.year, parsed.month, parsed.day, gfs_hour))
            env.set_atmospheric_model(type="Forecast", file="GFS")
            # Sanity checks: pressure 50,000–120,000 Pa and temperature 220–320 K
            # (RocketPy NOMADS unit bug returns pressure 100× too high — catches it here)
            surface_pressure = env.pressure(elevation)
            surface_temp = env.temperature(elevation)
            if not (50_000 <= surface_pressure <= 120_000):
                raise ValueError(
                    f"NOMADS GFS returned implausible pressure {surface_pressure:.0f} Pa at {elevation}m "
                    "(expected 50,000–120,000 Pa); falling back to standard atmosphere."
                )
            if not (220 <= surface_temp <= 320):
                raise ValueError(
                    f"NOMADS GFS returned implausible temperature {surface_temp:.1f} K at {elevation}m; "
                    "falling back to standard atmosphere."
                )
            weather_source = "NOMADS GFS"
            logger.info("NOMADS GFS active. P=%.0f Pa, T=%.1f K, wind=%.2f m/s at %dm",
                        surface_pressure, surface_temp, env.wind_speed(elevation), elevation)
        except Exception as exc:
            logger.warning("NOMADS GFS failed (%s); using standard_atmosphere.", exc)
            env = Environment(latitude=lat, longitude=lon, elevation=elevation)
            env.set_atmospheric_model(type="standard_atmosphere")
    else:
        env.set_atmospheric_model(type="standard_atmosphere")

    # ------------------------------------------------------------------
    # 2. SolidMotor
    # ------------------------------------------------------------------
    motor_params = params["motors"]

    thrust_csv = _resolve(motor_params["thrust_source"], output_dir)

    try:
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
            nozzle_position=motor_params.get("nozzle_position", 0.0),
            throat_radius=motor_params.get("throat_radius", 0.01),
            coordinate_system_orientation=motor_params.get(
                "coordinate_system_orientation", "nozzle_to_combustion_chamber"
            ),
        )
    except Exception:
        import traceback as _tb
        logger.error("SolidMotor failed\nthrust_csv=%s\nmotor_params=%s\n%s",
                     thrust_csv, motor_params, _tb.format_exc())
        raise

    # ------------------------------------------------------------------
    # 3. Rocket
    # ------------------------------------------------------------------
    rkt_params = params["rocket"]

    drag_csv = _resolve(rkt_params["drag_curve"], output_dir)

    # rocketserializer bug: exports inertia as (I_roll, I_roll, I_transverse) but
    # RocketPy expects (I_transverse, I_transverse, I_roll).  OpenRocket labels the
    # columns "Longitudinal MOI" (large, pitch/yaw axis) and "Rotational MOI" (small,
    # spin axis); rocketserializer assigns them to the wrong tuple positions.
    # Detect by checking whether the first element is smaller than the third — if so,
    # the tuple is backwards and we swap it.
    _raw_inertia = tuple(rkt_params["inertia"])
    if _raw_inertia[0] < _raw_inertia[2]:
        inertia_corrected = (_raw_inertia[2], _raw_inertia[2], _raw_inertia[0])
        logger.info(
            "Corrected rocketserializer inertia swap: %s -> %s", _raw_inertia, inertia_corrected
        )
    else:
        inertia_corrected = _raw_inertia

    rocket = Rocket(
        radius=rkt_params["radius"],
        mass=rkt_params["mass"],
        inertia=inertia_corrected,
        power_off_drag=drag_csv,
        power_on_drag=drag_csv,
        center_of_mass_without_motor=rkt_params["center_of_mass_without_propellant"],
        coordinate_system_orientation=rkt_params.get(
            "coordinate_system_orientation", "nose_to_tail"
        ),
    )

    # Motor — position stored in motor_params
    rocket.add_motor(motor, position=motor_params["position"])

    # Nosecones — single dict or dict-of-dicts
    nosecones_raw = params.get("nosecones", {})
    if isinstance(nosecones_raw, dict) and nosecones_raw:
        nc_list = [nosecones_raw] if "length" in nosecones_raw else list(nosecones_raw.values())
    else:
        nc_list = nosecones_raw if isinstance(nosecones_raw, list) else []
    for nc in nc_list:
        kind_raw = nc.get("kind", nc.get("shape", "ogive"))
        kind_norm = kind_raw.lower().replace(" ", "").replace("-", "")
        rocket.add_nose(
            length=nc["length"],
            kind=kind_norm,
            position=nc["position"],
            base_radius=nc.get("base_radius"),
        )

    # Trapezoidal fins
    fins_raw = params.get("trapezoidal_fins", {})
    fin_list = list(fins_raw.values()) if isinstance(fins_raw, dict) else fins_raw
    logger.info("fin_list count=%d keys=%s", len(fin_list), list(fins_raw.keys()))
    for fin in fin_list:
        kwargs = dict(
            n=fin["n"], root_chord=fin["root_chord"], tip_chord=fin["tip_chord"],
            span=fin["span"], position=fin["position"],
        )
        if "sweep_length" in fin:
            kwargs["sweep_length"] = fin["sweep_length"]
        rocket.add_trapezoidal_fins(**kwargs)

    # Tails — empty list or dict-of-dicts
    tails_raw = params.get("tails", [])
    tail_list = list(tails_raw.values()) if isinstance(tails_raw, dict) else tails_raw
    for tail in tail_list:
        rocket.add_tail(
            top_radius=tail["top_radius"],
            bottom_radius=tail["bottom_radius"],
            length=tail["length"],
            position=tail["position"],
        )

    # Parachutes — dict with string int keys {"0": {...}, "1": {...}}
    parachutes_raw = params.get("parachutes", {})
    chute_list = list(parachutes_raw.values()) if isinstance(parachutes_raw, dict) else parachutes_raw
    for chute in chute_list:
        deploy_event = chute.get("deploy_event", "apogee").lower()
        deploy_alt = chute.get("deploy_altitude")
        if deploy_event == "altitude" and deploy_alt is not None:
            trigger = float(deploy_alt)
        else:
            trigger = "apogee"
        rocket.add_parachute(
            name=chute["name"],
            cd_s=chute.get("cds", chute.get("cd_s", 1.0)),
            trigger=trigger,
        )

    # Rail buttons
    for rb in params.get("rail_buttons", []):
        rocket.set_rail_buttons(
            upper_button_position=rb["upper_position"],
            lower_button_position=rb["lower_position"],
        )

    # ------------------------------------------------------------------
    # Rocket diagram (base64 PNG, dark-themed)
    # ------------------------------------------------------------------
    rocket_diagram = None
    try:
        import io as _io
        import base64 as _b64
        import matplotlib as _mpl
        import matplotlib.pyplot as _plt

        _plt.close('all')  # clear any stale figures before draw

        with _plt.style.context('dark_background'):
            draw_result = rocket.draw()

        # Resolve fig regardless of what rocket.draw() returns:
        # - (fig, axes) tuple  → draw_result[0]
        # - Figure directly    → draw_result
        # - None / unknown     → most recently created figure via plt.gcf()
        if isinstance(draw_result, (list, tuple)) and draw_result:
            fig = draw_result[0]
        elif isinstance(draw_result, _mpl.figure.Figure):
            fig = draw_result
        else:
            nums = _plt.get_fignums()
            if not nums:
                raise RuntimeError("rocket.draw() created no figure")
            fig = _plt.figure(nums[-1])

        logger.info("rocket.draw() succeeded, fig type=%s axes=%d",
                    type(fig).__name__, len(fig.get_axes()))

        fig.patch.set_facecolor('#111827')
        for ax in fig.get_axes():
            ax.set_facecolor('#1f2937')
            for spine in ax.spines.values():
                spine.set_edgecolor('#374151')
            ax.tick_params(colors='#9ca3af')
            ax.xaxis.label.set_color('#9ca3af')
            ax.yaxis.label.set_color('#9ca3af')
            ax.title.set_color('#e5e7eb')

        buf = _io.BytesIO()
        fig.savefig(buf, format='png', dpi=130, bbox_inches='tight', facecolor='#111827')
        buf.seek(0)
        rocket_diagram = _b64.b64encode(buf.read()).decode('utf-8')
        logger.info("rocket_diagram encoded, length=%d bytes", len(rocket_diagram))
        _plt.close(fig)
    except Exception as exc:
        logger.warning("rocket.draw() failed: %s", exc, exc_info=True)

    # ------------------------------------------------------------------
    # 4. Flight
    # ------------------------------------------------------------------
    flight = Flight(
        rocket=rocket,
        environment=env,
        rail_length=rail_length,
        inclination=inclination,
        heading=heading,
        max_time=600,
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
    burn_out_time_s = float(motor.burn_out_time)

    # Stability margin at rail departure (most meaningful launch metric)
    try:
        static_margin_cal = float(flight.out_of_rail_stability_margin)
    except Exception:
        try:
            cp0 = rocket.cp_position(0)
            cg0 = rocket.center_of_mass(0)
            cso = rkt_params.get("coordinate_system_orientation", "nose_to_tail")
            _stab_sign = -1 if cso == "tail_to_nose" else 1
            static_margin_cal = float(_stab_sign * (cp0 - cg0) / (2 * rkt_params["radius"]))
        except Exception:
            static_margin_cal = 0.0

    # % stability = calibers × diameter / rocket_length × 100
    # rocket_length ≈ motor position from nose + nozzle extension below motor
    reference_diameter = 2.0 * rkt_params["radius"]
    rocket_length = motor_params["position"] + abs(motor_params.get("nozzle_position", 0))
    if rocket_length > 0 and reference_diameter > 0:
        static_margin_pct = static_margin_cal * reference_diameter / rocket_length * 100.0
    else:
        static_margin_pct = 0.0

    # ------------------------------------------------------------------
    # 6. Timeseries (downsampled to ≤500 pts)
    # ------------------------------------------------------------------
    alt_t, alt_v = _source_cols(flight.altitude)
    spd_t, spd_v = _source_cols(flight.speed)
    mach_t, mach_v = _source_cols(flight.mach_number)

    # Use altitude time axis as the canonical time vector
    time_arr = alt_t
    n = len(time_arr)

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

    # Dynamic stability — use flight.stability_margin (RocketPy Function of time)
    # accounts for both Mach-dependent CP and time-varying CG as propellant burns
    try:
        stab_t, stab_raw = _source_cols(flight.stability_margin)
        stab_v = np.interp(time_arr, stab_t, stab_raw)
    except Exception:
        stab_v = np.full(n, static_margin_cal)

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

        # Resample onto a uniform time grid so animation speed matches real time.
        # The ODE solver uses adaptive steps: dense during ascent, sparse during
        # parachute descent. Index-based subsampling would over-represent ascent.
        t_uniform = np.linspace(traj_t[0], traj_t[-1], 500)
        traj_x_rs = np.interp(t_uniform, traj_t, traj_x)
        traj_y_rs = np.interp(t_uniform, traj_t, traj_y)
        traj_z_rs = np.interp(t_uniform, traj_t, traj_z)

        trajectory_3d = {
            "t": t_uniform.tolist(),
            "x": traj_x_rs.tolist(),
            "y": traj_y_rs.tolist(),
            "z": traj_z_rs.tolist(),
        }

        # Nose orientation — velocity unit vector (nose ≈ direction of travel)
        try:
            vx_src = np.asarray(flight.vx.source)
            vy_src = np.asarray(flight.vy.source)
            vz_src = np.asarray(flight.vz.source)
            vx_v = np.interp(t_uniform, vx_src[:, 0], vx_src[:, 1])
            vy_v = np.interp(t_uniform, vy_src[:, 0], vy_src[:, 1])
            vz_v = np.interp(t_uniform, vz_src[:, 0], vz_src[:, 1])
            spd = np.sqrt(vx_v**2 + vy_v**2 + vz_v**2)
            spd = np.where(spd < 1e-6, 1.0, spd)
            trajectory_3d["ux"] = (vx_v / spd).tolist()
            trajectory_3d["uy"] = (vy_v / spd).tolist()
            trajectory_3d["uz"] = (vz_v / spd).tolist()
        except Exception as exc2:
            logger.warning("Could not extract orientation vectors: %s", exc2)
            trajectory_3d["ux"] = []
            trajectory_3d["uy"] = []
            trajectory_3d["uz"] = []

    except Exception as exc:
        logger.warning("Could not extract 3-D trajectory: %s", exc)
        trajectory_3d = {"t": [], "x": [], "y": [], "z": [], "ux": [], "uy": [], "uz": []}

    # ------------------------------------------------------------------
    # 8. KML export
    # ------------------------------------------------------------------
    kml_path = os.path.join(output_dir, "trajectory.kml")
    try:
        flight.export_kml(
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
        "static_margin_pct": static_margin_pct,
        "burn_out_time_s": burn_out_time_s,
        "timeseries": timeseries,
        "trajectory_3d": trajectory_3d,
        "weather_source": weather_source,
        "rocket_diagram": rocket_diagram,
        "launch_lat": lat,
        "launch_lon": lon,
        "launch_elevation_m": elevation,
    }
