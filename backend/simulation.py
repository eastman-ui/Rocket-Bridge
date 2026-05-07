import logging
import math
import os
import warnings
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
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


def _draw_rocket_profile(rkt_params: dict, nc_list: list, fin_list: list,
                          tail_list: list, motor_params: dict, rocket_obj) -> Optional[str]:
    """Custom rocket side-profile diagram in imperial units. Returns base64 PNG or None."""
    import io as _io
    import base64 as _b64
    import matplotlib.pyplot as plt

    M_IN = 39.3701

    try:
        body_r = rkt_params["radius"]
        cso = rkt_params.get("coordinate_system_orientation", "nose_to_tail")
        tail_to_nose = (cso == "tail_to_nose")

        total_len = motor_params["position"] + abs(motor_params.get("nozzle_position", 0) or 0)
        if total_len <= 0.1:
            total_len = 2.0

        # ---- nosecone -------------------------------------------------------
        nose = nc_list[0] if nc_list else None
        nose_len = nose["length"] if nose else total_len * 0.2
        nose_kind = (nose.get("kind", nose.get("shape", "ogive")) if nose else "ogive") \
                    .lower().replace(" ", "").replace("-", "")

        t_pts = np.linspace(0, 1, 80)
        if "conic" in nose_kind or nose_kind == "cone":
            ny = body_r * t_pts
        elif "power" in nose_kind:
            ny = body_r * t_pts ** 0.5
        elif "parab" in nose_kind:
            ny = body_r * (2 * t_pts - t_pts ** 2)
        elif "haack" in nose_kind or "karman" in nose_kind or "vonkar" in nose_kind:
            theta = np.arccos(np.clip(1 - 2 * t_pts, -1, 1))
            ny = body_r / np.sqrt(np.pi) * np.sqrt(np.maximum(theta - np.sin(2 * theta) / 2, 0))
        else:  # ogive default
            ny = body_r * np.sqrt(np.maximum(2 * t_pts - t_pts ** 2, 0))
        nx = t_pts * nose_len  # x: 0=tip, nose_len=base

        # ---- body contour ---------------------------------------------------
        # profile as (x, r) from nose tip to tail — build piecewise
        prof_x = list(nx)
        prof_r = list(ny)

        # Tails: sorted by position (nose_to_tail)
        sorted_tails = sorted(tail_list, key=lambda t: t.get("position", 0))
        prev_x = nose_len
        for tl in sorted_tails:
            tl_pos = tl["position"]
            if tail_to_nose:
                tl_pos = total_len - tl_pos - tl["length"]
            # straight body up to tail start
            prof_x += [prev_x, tl_pos]
            prof_r += [body_r, body_r]
            # tail transition
            prof_x += [tl_pos, tl_pos + tl["length"]]
            prof_r += [tl.get("top_radius", body_r), tl.get("bottom_radius", body_r * 0.7)]
            prev_x = tl_pos + tl["length"]
            body_r = tl.get("bottom_radius", body_r)

        prof_x += [prev_x, total_len]
        prof_r += [body_r, body_r]

        prof_x = np.array(prof_x)
        prof_r = np.array(prof_r)

        # ---- CG / CP --------------------------------------------------------
        cg_in = cp_in = None
        try:
            cg_raw = float(rocket_obj.center_of_mass(0))
            cg_in = (total_len - cg_raw if tail_to_nose else cg_raw) * M_IN
        except Exception:
            pass
        try:
            cp_raw = float(rocket_obj.cp_position(0))
            cp_in = (total_len - cp_raw if tail_to_nose else cp_raw) * M_IN
        except Exception:
            pass

        # ---- figure ---------------------------------------------------------
        fig, ax = plt.subplots(figsize=(13, 4))
        fig.patch.set_facecolor("#0f1117")
        ax.set_facecolor("#0f1117")

        # Body filled polygon (upper + mirrored lower)
        px = np.concatenate([prof_x, prof_x[::-1]]) * M_IN
        py = np.concatenate([prof_r, -prof_r[::-1]]) * M_IN
        ax.fill(px, py, facecolor="#1e2435", edgecolor="white", linewidth=1.4, zorder=3)

        # ---- fins -----------------------------------------------------------
        orig_body_r = rkt_params["radius"]  # fins attach to original body radius
        for fin in fin_list:
            rc = float(fin.get("root_chord", 0.1) or 0.1)
            tc = float(fin.get("tip_chord", 0.05) or 0.05)
            sp = float(fin.get("span", 0.05) or 0.05)
            sw = float(fin.get("sweep_length", 0.0) or 0.0)
            pos = float(fin.get("position", 0) or 0)

            if tail_to_nose:
                pos = total_len - pos - rc

            # Safety clamp so fins don't render past the diagram extent
            pos = max(0.0, min(pos, total_len - rc))

            xrl = pos
            xrt = pos + rc
            xtl = xrl + sw
            xtt = xtl + tc
            yr = orig_body_r
            yt = orig_body_r + sp

            fin_px = np.array([xrl, xrt, xtt, xtl]) * M_IN
            fin_py_top = np.array([yr, yr, yt, yt]) * M_IN
            ax.fill(fin_px, fin_py_top, facecolor="#1e2435", edgecolor="white", linewidth=1.2, zorder=2)
            ax.fill(fin_px, -fin_py_top, facecolor="#1e2435", edgecolor="white", linewidth=1.2, zorder=2)

        # ---- CG / CP markers ------------------------------------------------
        max_r_in = (orig_body_r + max((f.get("span", 0) for f in fin_list), default=0)) * M_IN
        body_r_in = orig_body_r * M_IN
        label_y = body_r_in * 1.1  # just above / below body tube in data coords

        if cg_in is not None:
            ax.plot([cg_in, cg_in], [-body_r_in, body_r_in],
                    color="#f59e0b", linewidth=1.5, linestyle="--", alpha=0.85, zorder=6)
            ax.text(cg_in, label_y, "CG", color="#f59e0b", fontsize=7.5,
                    ha="center", va="bottom", fontweight="bold")

        if cp_in is not None:
            ax.plot([cp_in, cp_in], [-body_r_in, body_r_in],
                    color="#34d399", linewidth=1.5, linestyle="--", alpha=0.85, zorder=6)
            ax.text(cp_in, -label_y, "CP", color="#34d399", fontsize=7.5,
                    ha="center", va="top", fontweight="bold")

        # ---- axes & labels --------------------------------------------------
        total_in = total_len * M_IN
        diam_in = rkt_params["radius"] * 2 * M_IN

        ax.set_xlim(-0.3, total_in + 0.3)
        ax.set_ylim(-max_r_in * 1.6, max_r_in * 1.6)
        ax.set_aspect("equal", adjustable="datalim")

        ax.set_xlabel("Axial position (in)", color="#6b7280", fontsize=8)
        ax.tick_params(axis="x", colors="#6b7280", labelsize=7)
        ax.yaxis.set_visible(False)
        for spine in ["left", "right", "top"]:
            ax.spines[spine].set_visible(False)
        ax.spines["bottom"].set_edgecolor("#374151")

        ax.set_title(
            f"Length: {total_in:.1f} in    Diameter: {diam_in:.2f} in",
            color="#9ca3af", fontsize=8, pad=5,
        )
        ax.grid(False)

        buf = _io.BytesIO()
        fig.savefig(buf, format="png", dpi=150, bbox_inches="tight", facecolor="#0f1117")
        buf.seek(0)
        result = _b64.b64encode(buf.read()).decode("utf-8")
        plt.close(fig)
        return result

    except Exception as exc:
        logger.warning("_draw_rocket_profile failed: %s", exc, exc_info=True)
        return None


def _draw_fin_comparison(fin_list: list) -> Optional[str]:
    """Draw freeform vs trapezoidal fin comparison. Returns base64 PNG or None."""
    import io as _io
    import base64 as _b64
    import matplotlib.pyplot as plt
    from matplotlib.patches import Polygon as MplPolygon

    fins_with_points = [f for f in fin_list if f.get("freeform_points")]
    if not fins_with_points:
        return None

    M_IN = 39.3701
    n_fins = min(len(fins_with_points), 3)

    try:
        fig, axes = plt.subplots(1, n_fins, figsize=(4 * n_fins, 3.5), dpi=150)
        fig.patch.set_facecolor("#0f1117")
        if n_fins == 1:
            axes = [axes]

        for idx, fin in enumerate(fins_with_points[:n_fins]):
            ax = axes[idx]
            ax.set_facecolor("#0f1117")

            pts = fin["freeform_points"]
            xs_free = [p[0] * M_IN for p in pts] + [pts[0][0] * M_IN]
            ys_free = [p[1] * M_IN for p in pts] + [pts[0][1] * M_IN]

            rc = fin.get("root_chord", 0.1) * M_IN
            tc = fin.get("tip_chord", 0.05) * M_IN
            sp = fin.get("span", 0.05) * M_IN
            sw = fin.get("sweep_length", 0) * M_IN

            # Trapezoidal vertices: (x, y) — root LE, root TE, tip TE, tip LE
            trap_x = [0, rc, sw + tc, sw, 0]
            trap_y = [0, 0, sp, sp, 0]

            ax.fill(xs_free, ys_free, facecolor="#3b82f6", alpha=0.35, edgecolor="#3b82f6",
                    linewidth=1.5, label="Original (freeform)")
            ax.plot(trap_x, trap_y, color="#f97316", linewidth=2, linestyle="--",
                    label="Approximation (trapezoidal)")

            ax.set_aspect("equal", adjustable="datalim")
            ax.set_xlabel("Axial (in)", color="#6b7280", fontsize=7)
            ax.set_ylabel("Radial (in)", color="#6b7280", fontsize=7)
            ax.tick_params(colors="#6b7280", labelsize=6)
            for spine in ax.spines.values():
                spine.set_edgecolor("#374151")
            ax.legend(fontsize=7, loc="upper right", facecolor="#1f2937",
                      edgecolor="#374151", labelcolor="#d1d5db")
            ax.set_title(f"Fin Set {idx + 1}", color="#9ca3af", fontsize=8, pad=4)

        fig.suptitle("Fin Shape Comparison", color="#d1d5db", fontsize=10, y=0.98)
        fig.tight_layout(rect=[0, 0, 1, 0.94])

        buf = _io.BytesIO()
        fig.savefig(buf, format="png", dpi=150, bbox_inches="tight", facecolor="#0f1117")
        buf.seek(0)
        result = _b64.b64encode(buf.read()).decode("utf-8")
        plt.close(fig)
        return result

    except Exception as exc:
        logger.warning("_draw_fin_comparison failed: %s", exc, exc_info=True)
        return None


def _compute_hourly_landings(
    env: "Environment",
    lat: float, lon: float,
    apogee_lat: float, apogee_lon: float,
    traj_t: np.ndarray, traj_z: np.ndarray,
    apogee_time_s: float,
    sim_datetime: Optional[str],
) -> list:
    """
    Predict landing positions for each GFS forecast hour by reusing the
    already-loaded Environment.  env.set_date() swaps the wind profile
    to each forecast hour without a new NOMADS download, so there are no
    extra netCDF4/HDF5 calls and no thread-safety issues.
    """
    if sim_datetime:
        base_dt = datetime.fromisoformat(sim_datetime).replace(tzinfo=timezone.utc)
    else:
        base_dt = datetime.now(tz=timezone.utc)

    # Hourly slots from the current hour through 00Z next day
    start_hour = base_dt.replace(minute=0, second=0, microsecond=0)
    end_dt = base_dt.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
    slots, cur = [], start_hour
    while cur <= end_dt:
        slots.append(cur)
        cur += timedelta(hours=1)

    if not slots:
        return []

    # Descent profile after apogee, downsampled to ≤200 pts
    apogee_i = int(np.argmin(np.abs(traj_t - apogee_time_s)))
    desc_t = traj_t[apogee_i:]
    desc_z = traj_z[apogee_i:]
    if len(desc_t) > 200:
        step = len(desc_t) // 200
        desc_t = desc_t[::step]
        desc_z = desc_z[::step]

    results = []
    for slot_dt in slots:
        try:
            env.set_date((slot_dt.year, slot_dt.month, slot_dt.day, slot_dt.hour))

            p_lat, p_lon = apogee_lat, apogee_lon
            for i in range(len(desc_t) - 1):
                alt_asl = float(desc_z[i])
                dt_step = float(desc_t[i + 1] - desc_t[i])
                if dt_step <= 0:
                    continue
                try:
                    u = float(env.wind_velocity_x(alt_asl))
                    v = float(env.wind_velocity_y(alt_asl))
                except Exception:
                    u = v = 0.0
                p_lat += v * dt_step / 111111.0
                p_lon += u * dt_step / (111111.0 * math.cos(math.radians(p_lat)))

            results.append({
                "hour": slot_dt.strftime("%Y-%m-%dT%H:00"),
                "lat": round(p_lat, 6),
                "lon": round(p_lon, 6),
            })
        except Exception as exc:
            logger.warning("hourly_landing %s failed: %s", slot_dt.strftime("%H"), exc)

    results.sort(key=lambda r: r["hour"])
    return results


# ---------------------------------------------------------------------------
# Environment builder (shared by run_rocketpy and monte_carlo)
# ---------------------------------------------------------------------------

def _build_environment(
    lat: float, lon: float, elevation: float,
    sim_datetime: Optional[str] = None,
) -> tuple["Environment", str]:
    """Build a RocketPy Environment with NOMADS GFS if available.

    Returns (env, weather_source) so callers can reuse the Environment
    across multiple RocketPy runs without re-downloading GFS data.
    """
    env = Environment(latitude=lat, longitude=lon, elevation=elevation)
    weather_source = "standard_atmosphere"
    try:
        if sim_datetime:
            from datetime import datetime as _dt
            parsed = _dt.fromisoformat(sim_datetime).replace(tzinfo=timezone.utc)
        else:
            parsed = datetime.now(tz=timezone.utc)
        gfs_hour = (parsed.hour // 6) * 6
        env.set_date((parsed.year, parsed.month, parsed.day, gfs_hour))
        import concurrent.futures as _cf
        with _cf.ThreadPoolExecutor(max_workers=1) as _ex:
            _fut = _ex.submit(env.set_atmospheric_model, type="Forecast", file="GFS")
            _fut.result(timeout=45)
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
    return env, weather_source


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
    prebuilt_env: "Environment | None" = None,
) -> dict:
    """Run RocketPy simulation from a parameters.json dict.

    User-supplied lat/lon/elevation override whatever is stored in params.

    Returns a results dict compatible with RocketPyResults / the frontend.
    """

    # ------------------------------------------------------------------
    # 1. Environment
    # ------------------------------------------------------------------
    if prebuilt_env is not None:
        env = prebuilt_env
        weather_source = "NOMADS GFS" if use_live_weather else "standard_atmosphere"
    elif use_live_weather:
        env, weather_source = _build_environment(lat, lon, elevation, sim_datetime)
    else:
        env = Environment(latitude=lat, longitude=lon, elevation=elevation)
        env.set_atmospheric_model(type="standard_atmosphere")
        weather_source = "standard_atmosphere"

    # ------------------------------------------------------------------
    # 2. SolidMotor
    # ------------------------------------------------------------------
    motor_params = params["motors"]

    thrust_csv = _resolve(motor_params["thrust_source"], output_dir)

    # Defensive defaults for keys rocketserializer may omit or zero-out.
    # Converter patches improve many of these — fallbacks are last resort.
    _grain_number = max(1, int(motor_params.get("grain_number", 1) or 1))
    _grain_or = float(motor_params.get("grain_outer_radius", 0) or 0)
    _grain_ir = float(motor_params.get("grain_initial_inner_radius", 0) or 0)
    _grain_h  = float(motor_params.get("grain_initial_height",  0) or 0)

    # If grain geometry is degenerate (rocketserializer bug on multi-grain motors),
    # synthesize plausible geometry from nozzle_radius so RocketPy won't divide by zero.
    _nozzle_r = float(motor_params.get("nozzle_radius", 0.02) or 0.02)
    if _grain_or <= 0:
        _grain_or = _nozzle_r * 2.5
    if _grain_ir <= 0 or _grain_ir >= _grain_or:
        _grain_ir = _grain_or * 0.3
    if _grain_h <= 0:
        _grain_h = _grain_or * 3.0

    # Grain density: prefer converter-computed value (derived from propellant mass
    # and grain volume), then serializer value, then APCP fallback.
    _grain_density = float(motor_params.get("grain_density", 0) or 0)
    if _grain_density <= 0:
        _grain_volume = math.pi * (_grain_or ** 2 - _grain_ir ** 2) * _grain_h * _grain_number
        _prop_mass = float(motor_params.get("propellant_mass", 0) or 0)
        if _prop_mass > 0 and _grain_volume > 0:
            _derived = _prop_mass / _grain_volume
            if 800 <= _derived <= 2200:
                _grain_density = _derived
        if _grain_density <= 0:
            _grain_density = 1750.0  # typical APCP density (kg/m³)

    # Dry inertia: prefer converter-computed solid-cylinder estimate over zeros.
    _dry_inertia_raw = motor_params.get("dry_inertia", [0, 0, 0]) or [0, 0, 0]
    if all(v == 0 for v in _dry_inertia_raw):
        _dry_mass = float(motor_params.get("dry_mass", 0) or 0)
        if _dry_mass > 0 and _grain_or > 0:
            _motor_len = _grain_h * _grain_number if _grain_h > 0 else _grain_or * 6
            _I_long = _dry_mass * (3 * _grain_or ** 2 + _motor_len ** 2) / 12.0
            _I_rot = _dry_mass * _grain_or ** 2 / 2.0
            _dry_inertia = (_I_long, _I_long, _I_rot)
        else:
            _dry_inertia = tuple(_dry_inertia_raw)
    else:
        _dry_inertia = tuple(_dry_inertia_raw)

    _motor_pos = float(motor_params.get("position", 0) or 0)
    # Grain CG in motor-local coords (nozzle=0, positive toward combustion chamber):
    # rocketserializer often outputs 0 (falsy). Use grain_height/2 as the physical
    # centroid for a single-grain stack; multiply by grain_number for multi-grain.
    _grain_stack_h = _grain_h * _grain_number
    _grains_cg_default = _grain_stack_h / 2.0 if _grain_stack_h > 0 else 0.1
    # Motor dry CG: place at half the grain stack height (case wraps the grains)
    _dry_cg_default = _grain_stack_h / 2.0 if _grain_stack_h > 0 else 0.1

    try:
        motor = SolidMotor(
            thrust_source=thrust_csv,
            dry_mass=float(motor_params.get("dry_mass", 0) or 0),
            dry_inertia=_dry_inertia,
            nozzle_radius=_nozzle_r,
            grain_number=_grain_number,
            grain_density=_grain_density,
            grain_outer_radius=_grain_or,
            grain_initial_inner_radius=_grain_ir,
            grain_initial_height=_grain_h,
            grain_separation=float(motor_params.get("grain_separation", 0.005) or 0.005),
            grains_center_of_mass_position=float(
                motor_params.get("grains_center_of_mass_position") or _grains_cg_default
            ),
            center_of_dry_mass_position=float(
                motor_params.get("center_of_dry_mass_position") or _dry_cg_default
            ),
            nozzle_position=float(motor_params.get("nozzle_position", 0.0) or 0.0),
            throat_radius=float(motor_params.get("throat_radius", _nozzle_r * 0.6) or _nozzle_r * 0.6),
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
    rocket.add_motor(motor, position=float(motor_params.get("position", 0) or 0))

    # Nosecones — single dict or dict-of-dicts
    nosecones_raw = params.get("nosecones", {})
    if isinstance(nosecones_raw, dict) and nosecones_raw:
        nc_list = [nosecones_raw] if "length" in nosecones_raw else list(nosecones_raw.values())
    else:
        nc_list = nosecones_raw if isinstance(nosecones_raw, list) else []
    for nc in nc_list:
        kind_raw = nc.get("kind", nc.get("shape", "ogive")) or "ogive"
        kind_norm = kind_raw.lower().replace(" ", "").replace("-", "")
        try:
            rocket.add_nose(
                length=float(nc.get("length", rkt_params["radius"] * 3) or rkt_params["radius"] * 3),
                kind=kind_norm,
                position=float(nc.get("position", 0) or 0),
                base_radius=nc.get("base_radius"),
            )
        except Exception as exc:
            logger.warning("add_nose failed (%s) — skipping nosecone: %s", exc, nc)

    # Trapezoidal fins — rocketserializer uses "n", "number", or "count" for fin count
    fins_raw = params.get("trapezoidal_fins", {})
    fin_list = list(fins_raw.values()) if isinstance(fins_raw, dict) else fins_raw
    logger.info("fin_list count=%d", len(fin_list))
    _rocket_len = motor_params.get("position", 0) + abs(motor_params.get("nozzle_position", 0) or 0)
    for fin in fin_list:
        _n = int(fin.get("n", fin.get("number", fin.get("fin_count", fin.get("count", 3)))) or 3)
        _pos = float(fin.get("position", 0) or 0)
        kwargs = dict(
            n=_n,
            root_chord=float(fin.get("root_chord", 0.1) or 0.1),
            tip_chord=float(fin.get("tip_chord", 0.05) or 0.05),
            span=float(fin.get("span", 0.05) or 0.05),
            position=_pos,
        )
        if fin.get("sweep_length") is not None:
            kwargs["sweep_length"] = float(fin["sweep_length"])
        try:
            rocket.add_trapezoidal_fins(**kwargs)
        except Exception as exc:
            logger.warning("add_trapezoidal_fins failed (%s) — skipping fin set: %s", exc, fin)

    # Tails — empty list or dict-of-dicts
    tails_raw = params.get("tails", [])
    tail_list = list(tails_raw.values()) if isinstance(tails_raw, dict) else tails_raw
    for tail in tail_list:
        try:
            rocket.add_tail(
                top_radius=float(tail.get("top_radius", rkt_params["radius"]) or rkt_params["radius"]),
                bottom_radius=float(tail.get("bottom_radius", rkt_params["radius"] * 0.7) or rkt_params["radius"] * 0.7),
                length=float(tail.get("length", 0.1) or 0.1),
                position=float(tail.get("position", _rocket_len) or _rocket_len),
            )
        except Exception as exc:
            logger.warning("add_tail failed (%s) — skipping tail: %s", exc, tail)

    # Parachutes — dict with string int keys {"0": {...}, "1": {...}}
    parachutes_raw = params.get("parachutes", {})
    chute_list = list(parachutes_raw.values()) if isinstance(parachutes_raw, dict) else parachutes_raw
    for i, chute in enumerate(chute_list):
        deploy_event = (chute.get("deploy_event", "apogee") or "apogee").lower()
        deploy_alt = chute.get("deploy_altitude")
        if deploy_event == "altitude" and deploy_alt is not None:
            trigger = float(deploy_alt)
        else:
            trigger = "apogee"
        try:
            rocket.add_parachute(
                name=chute.get("name", f"chute_{i}") or f"chute_{i}",
                cd_s=float(chute.get("cds", chute.get("cd_s", chute.get("cd", 1.0))) or 1.0),
                trigger=trigger,
            )
        except Exception as exc:
            logger.warning("add_parachute failed (%s) — skipping chute: %s", exc, chute)

    # Rail buttons — rocketserializer may export as flat dict (single set) or list
    _rb_raw = params.get("rail_buttons", []) or []
    if isinstance(_rb_raw, dict):
        _rb_raw = [_rb_raw] if ("upper_button_position" in _rb_raw or "upper_position" in _rb_raw) else list(_rb_raw.values())
    for rb in (rb for rb in _rb_raw if isinstance(rb, dict)):
        try:
            rocket.set_rail_buttons(
                upper_button_position=float(rb.get("upper_position", rb.get("upper_button_position", 0)) or 0),
                lower_button_position=float(rb.get("lower_position", rb.get("lower_button_position", 0)) or 0),
            )
        except Exception as exc:
            logger.warning("set_rail_buttons failed (%s) — skipping", exc)

    # ------------------------------------------------------------------
    # Rocket diagram — custom imperial profile
    # ------------------------------------------------------------------
    rocket_diagram = _draw_rocket_profile(
        rkt_params=rkt_params,
        nc_list=nc_list,
        fin_list=fin_list,
        tail_list=tail_list,
        motor_params=motor_params,
        rocket_obj=rocket,
    )

    fin_comparison_diagram = _draw_fin_comparison(fin_list)

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

    def _safe_max(flight_prop, source_func=None) -> float:
        """Extract scalar max, falling back to nanmax of raw source if spline has NaN."""
        try:
            v = float(flight_prop)
            if np.isfinite(v):
                return v
        except Exception:
            pass
        if source_func is not None:
            try:
                _, vals = _source_cols(source_func)
                finite = vals[np.isfinite(vals)]
                if len(finite) > 0:
                    return float(np.max(finite))
            except Exception:
                pass
        return 0.0

    max_speed_ms = _safe_max(flight.max_speed, flight.speed)
    max_mach = _safe_max(flight.max_mach_number, flight.mach_number)
    max_acceleration_ms2 = _safe_max(flight.max_acceleration)

    try:
        out_of_rail_velocity = float(flight.out_of_rail_velocity)
    except Exception:
        out_of_rail_velocity = 0.0

    burn_out_time_s = float(motor.burn_out_time)

    # Impact / landing velocity and drift distance
    impact_velocity_ms = 0.0
    drift_distance_m = 0.0
    try:
        impact_velocity_ms = float(flight.impact_velocity)
    except Exception:
        pass
    try:
        x_imp = float(flight.x_impact)
        y_imp = float(flight.y_impact)
        drift_distance_m = float(np.sqrt(x_imp**2 + y_imp**2))
    except Exception:
        pass

    # Parachute descent speed — use the last 20% of the trajectory (descent under chute)
    main_descent_speed_ms = 0.0
    drogue_descent_speed_ms = 0.0
    try:
        spd_t_src, spd_v_src = _source_cols(flight.speed)
        if len(spd_t_src) > 10:
            # Last 20% of flight = descent under chute
            n = len(spd_t_src)
            descent = spd_v_src[int(n * 0.8):]
            descent = descent[np.isfinite(descent)]
            if len(descent) > 0:
                main_descent_speed_ms = float(np.median(descent))
    except Exception:
        pass

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

    # CP and CG positions from nose at t=0 (meters)
    cp_position_m: Optional[float] = None
    cg_position_m: Optional[float] = None
    try:
        _cso = rkt_params.get("coordinate_system_orientation", "nose_to_tail")
        _tail_to_nose = (_cso == "tail_to_nose")
        _cp_raw = float(rocket.cp_position(0))
        _cg_raw = float(rocket.center_of_mass(0))
        # Convert to "distance from nose" in meters
        if _tail_to_nose:
            cp_position_m = rocket_length - _cp_raw
            cg_position_m = rocket_length - _cg_raw
        else:
            cp_position_m = _cp_raw
            cg_position_m = _cg_raw
    except Exception:
        pass

    # ------------------------------------------------------------------
    # 6. Timeseries (downsampled to ≤500 pts)
    # ------------------------------------------------------------------
    alt_t, alt_v = _source_cols(flight.altitude)
    alt_v = np.nan_to_num(alt_v, nan=0.0, posinf=0.0, neginf=0.0)

    try:
        spd_t, spd_v = _source_cols(flight.speed)
        spd_v = np.nan_to_num(spd_v, nan=0.0, posinf=0.0, neginf=0.0)
    except Exception:
        spd_t, spd_v = alt_t, np.zeros_like(alt_t)

    try:
        mach_t, mach_v = _source_cols(flight.mach_number)
        mach_v = np.nan_to_num(mach_v, nan=0.0, posinf=0.0, neginf=0.0)
    except Exception:
        mach_t, mach_v = alt_t, np.zeros_like(alt_t)

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

    # Stability at Mach 0.3 — fair comparison point between simulators
    static_margin_mach03_cal = 0.0
    static_margin_mach03_pct = 0.0
    try:
        valid = ~np.isnan(stab_v) & ~np.isnan(mach_resampled) & (mach_resampled > 0)
        if np.any(valid):
            mv, sv = mach_resampled[valid], stab_v[valid]
            order = np.argsort(mv)
            mv, sv = mv[order], sv[order]
            if mv[0] <= 0.3 <= mv[-1]:
                sm03 = float(np.interp(0.3, mv, sv))
                if not np.isnan(sm03):
                    static_margin_mach03_cal = sm03
                    if rocket_length > 0 and reference_diameter > 0:
                        static_margin_mach03_pct = sm03 * reference_diameter / rocket_length * 100.0
    except Exception:
        pass

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
    traj_t = traj_x = traj_y = traj_z = None
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
    # 8. Hourly landing predictions (reuse env — no extra NOMADS calls)
    # ------------------------------------------------------------------
    hourly_landings: list = []
    if use_live_weather and traj_t is not None and traj_z is not None and len(traj_t) > 1:
        _ai = int(np.argmin(np.abs(traj_t - apogee_time_s)))
        _apogee_lat = lat + float(traj_y[_ai]) / 111111.0
        _apogee_lon = lon + float(traj_x[_ai]) / (111111.0 * math.cos(math.radians(lat)))
        hourly_landings = _compute_hourly_landings(
            env=env,
            lat=lat, lon=lon,
            apogee_lat=_apogee_lat, apogee_lon=_apogee_lon,
            traj_t=traj_t, traj_z=traj_z,
            apogee_time_s=apogee_time_s,
            sim_datetime=sim_datetime,
        )
        logger.info("hourly_landings computed: %d slots", len(hourly_landings))

    # ------------------------------------------------------------------
    # 9. KML export
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
        "cp_position_m": cp_position_m,
        "cg_position_m": cg_position_m,
        "static_margin_mach03_cal": static_margin_mach03_cal,
        "static_margin_mach03_pct": static_margin_mach03_pct,
        "burn_out_time_s": burn_out_time_s,
        "impact_velocity_ms": impact_velocity_ms,
        "drift_distance_m": drift_distance_m,
        "main_descent_speed_ms": main_descent_speed_ms,
        "drogue_descent_speed_ms": drogue_descent_speed_ms,
        "timeseries": timeseries,
        "trajectory_3d": trajectory_3d,
        "weather_source": weather_source,
        "rocket_diagram": rocket_diagram,
        "fin_comparison_diagram": fin_comparison_diagram,
        "launch_lat": lat,
        "launch_lon": lon,
        "launch_elevation_m": elevation,
        "hourly_landings": hourly_landings,
    }
