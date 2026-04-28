"""Monte Carlo dispersion analysis via N randomized RocketPy simulations."""
import asyncio
import copy
import logging
import math
import os
from concurrent.futures import ProcessPoolExecutor
from typing import Optional

import numpy as np

from simulation import _build_environment

logger = logging.getLogger(__name__)

# Global pool — created lazily, sized to CPU count (max 6 to avoid memory pressure)
_pool: ProcessPoolExecutor | None = None


def _get_pool() -> ProcessPoolExecutor:
    global _pool
    if _pool is None or _pool._broken:
        _pool = ProcessPoolExecutor(max_workers=min(os.cpu_count() or 2, 6))
    return _pool


def _percentile(arr: list[float], p: float) -> float:
    if not arr:
        return 0.0
    sorted_arr = sorted(arr)
    idx = (len(sorted_arr) - 1) * p / 100
    lo, hi = int(idx), min(int(idx) + 1, len(sorted_arr) - 1)
    return sorted_arr[lo] + (sorted_arr[hi] - sorted_arr[lo]) * (idx - lo)


def _stats(arr: list[float]) -> dict:
    if not arr:
        return {"mean": 0, "std": 0, "p5": 0, "p50": 0, "p95": 0}
    a = np.array(arr)
    return {
        "mean": float(np.mean(a)),
        "std": float(np.std(a)),
        "p5": float(_percentile(arr, 5)),
        "p50": float(_percentile(arr, 50)),
        "p95": float(_percentile(arr, 95)),
    }


# ---------------------------------------------------------------------------
# Lightweight simulation for MC — skips diagram, KML, timeseries, etc.
# ---------------------------------------------------------------------------

def _mc_flight(
    params: dict,
    lat: float, lon: float, elevation: float,
    rail_length: float, inclination: float, heading: float,
    use_live_weather: bool,
    sim_datetime: str | None,
) -> dict:
    """Run a single RocketPy flight and return only the scalar results MC needs.

    Dispatched to worker processes via ProcessPoolExecutor. Builds its own
    Environment (can't json/pickle Environment across processes) and skips
    all expensive output generation (diagram, KML, timeseries, trajectory).
    """
    from rocketpy import Environment, Flight, Rocket, SolidMotor

    # 1. Environment
    if use_live_weather:
        try:
            env, _ = _build_environment(lat, lon, elevation, sim_datetime)
        except Exception:
            env = Environment(latitude=lat, longitude=lon, elevation=elevation)
            env.set_atmospheric_model(type="standard_atmosphere")
    else:
        env = Environment(latitude=lat, longitude=lon, elevation=elevation)
        env.set_atmospheric_model(type="standard_atmosphere")

    # 2. SolidMotor
    motor_params = params["motors"]
    thrust_csv = motor_params["thrust_source"]

    _grain_number = max(1, int(motor_params.get("grain_number", 1) or 1))
    _grain_or = float(motor_params.get("grain_outer_radius", 0) or 0)
    _grain_ir = float(motor_params.get("grain_initial_inner_radius", 0) or 0)
    _grain_h = float(motor_params.get("grain_initial_height", 0) or 0)
    _nozzle_r = float(motor_params.get("nozzle_radius", 0.02) or 0.02)
    if _grain_or <= 0:
        _grain_or = _nozzle_r * 2.5
    if _grain_ir <= 0 or _grain_ir >= _grain_or:
        _grain_ir = _grain_or * 0.3
    if _grain_h <= 0:
        _grain_h = _grain_or * 3.0

    # Grain density: prefer converter-derived value, then fallback
    _grain_density = float(motor_params.get("grain_density", 0) or 0)
    if _grain_density <= 0:
        import math as _math
        _grain_volume = _math.pi * (_grain_or ** 2 - _grain_ir ** 2) * _grain_h * _grain_number
        _prop_mass = float(motor_params.get("propellant_mass", 0) or 0)
        if _prop_mass > 0 and _grain_volume > 0:
            _derived = _prop_mass / _grain_volume
            if 800 <= _derived <= 2200:
                _grain_density = _derived
        if _grain_density <= 0:
            _grain_density = 1750.0

    # Dry inertia: prefer converter-computed estimate over zeros
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

    _grain_stack_h = _grain_h * _grain_number
    _grains_cg_default = _grain_stack_h / 2.0 if _grain_stack_h > 0 else 0.1
    _dry_cg_default = _grain_stack_h / 2.0 if _grain_stack_h > 0 else 0.1

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

    # 3. Rocket
    rkt_params = params["rocket"]
    drag_csv = rkt_params["drag_curve"]

    _raw_inertia = tuple(rkt_params["inertia"])
    if _raw_inertia[0] < _raw_inertia[2]:
        inertia_corrected = (_raw_inertia[2], _raw_inertia[2], _raw_inertia[0])
    else:
        inertia_corrected = _raw_inertia

    rocket = Rocket(
        radius=rkt_params["radius"],
        mass=rkt_params["mass"],
        inertia=inertia_corrected,
        power_off_drag=drag_csv,
        power_on_drag=drag_csv,
        center_of_mass_without_motor=rkt_params["center_of_mass_without_propellant"],
        coordinate_system_orientation=rkt_params.get("coordinate_system_orientation", "nose_to_tail"),
    )
    rocket.add_motor(motor, position=float(motor_params.get("position", 0) or 0))

    # Nosecones
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
        except Exception:
            pass

    # Fins
    fins_raw = params.get("trapezoidal_fins", {})
    fin_list = list(fins_raw.values()) if isinstance(fins_raw, dict) else fins_raw
    for fin in fin_list:
        _n = int(fin.get("n", fin.get("number", fin.get("fin_count", fin.get("count", 3)))) or 3)
        kwargs = dict(
            n=_n,
            root_chord=float(fin.get("root_chord", 0.1) or 0.1),
            tip_chord=float(fin.get("tip_chord", 0.05) or 0.05),
            span=float(fin.get("span", 0.05) or 0.05),
            position=float(fin.get("position", 0) or 0),
        )
        if fin.get("sweep_length") is not None:
            kwargs["sweep_length"] = float(fin["sweep_length"])
        try:
            rocket.add_trapezoidal_fins(**kwargs)
        except Exception:
            pass

    # Tails
    tails_raw = params.get("tails", [])
    tail_list = list(tails_raw.values()) if isinstance(tails_raw, dict) else tails_raw
    for tail in tail_list:
        try:
            rocket.add_tail(
                top_radius=float(tail.get("top_radius", rkt_params["radius"]) or rkt_params["radius"]),
                bottom_radius=float(tail.get("bottom_radius", rkt_params["radius"] * 0.7) or rkt_params["radius"] * 0.7),
                length=float(tail.get("length", 0.1) or 0.1),
                position=float(tail.get("position", 0) or 0),
            )
        except Exception:
            pass

    # Parachutes
    parachutes_raw = params.get("parachutes", {})
    chute_list = list(parachutes_raw.values()) if isinstance(parachutes_raw, dict) else parachutes_raw
    for i, chute in enumerate(chute_list):
        deploy_event = (chute.get("deploy_event", "apogee") or "apogee").lower()
        deploy_alt = chute.get("deploy_altitude")
        trigger = float(deploy_alt) if deploy_event == "altitude" and deploy_alt is not None else "apogee"
        try:
            rocket.add_parachute(
                name=chute.get("name", f"chute_{i}") or f"chute_{i}",
                cd_s=float(chute.get("cds", chute.get("cd_s", chute.get("cd", 1.0))) or 1.0),
                trigger=trigger,
            )
        except Exception:
            pass

    # Rail buttons
    for rb in params.get("rail_buttons", []):
        try:
            rocket.set_rail_buttons(
                upper_button_position=float(rb.get("upper_position", rb.get("upper_button_position", 0)) or 0),
                lower_button_position=float(rb.get("lower_position", rb.get("lower_button_position", 0)) or 0),
            )
        except Exception:
            pass

    # 4. Flight
    flight = Flight(
        rocket=rocket,
        environment=env,
        rail_length=rail_length,
        inclination=inclination,
        heading=heading,
        max_time=600,
    )

    # 5. Extract only scalars MC needs (no timeseries, trajectory, diagram, KML)
    apogee_m_agl = float(flight.apogee) - elevation

    def _safe_max(prop) -> float:
        try:
            v = float(prop)
            if np.isfinite(v):
                return v
        except Exception:
            pass
        return 0.0

    max_speed_ms = _safe_max(flight.max_speed)
    static_margin_cal = 0.0
    try:
        static_margin_cal = float(flight.out_of_rail_stability_margin)
    except Exception:
        try:
            cso = rkt_params.get("coordinate_system_orientation", "nose_to_tail")
            sign = -1 if cso == "tail_to_nose" else 1
            static_margin_cal = float(sign * (rocket.cp_position(0) - rocket.center_of_mass(0)) / (2 * rkt_params["radius"]))
        except Exception:
            pass

    # Landing position
    landing = None
    try:
        x_arr = np.asarray(flight.x.source)[:, 1]
        y_arr = np.asarray(flight.y.source)[:, 1]
        land_lat = lat + float(y_arr[-1]) / 111111.0
        land_lon = lon + float(x_arr[-1]) / (111111.0 * math.cos(math.radians(lat)))
        landing = {"lat": round(land_lat, 6), "lon": round(land_lon, 6)}
    except Exception:
        pass

    return {
        "apogee_m_agl": apogee_m_agl,
        "max_speed_ms": max_speed_ms,
        "static_margin_cal": static_margin_cal,
        "landing": landing,
    }


async def run_monte_carlo(
    base_params: dict,
    lat: float,
    lon: float,
    elevation: float,
    rail_length: float,
    inclination: float,
    heading: float,
    n_sims: int,
    wind_speed_std_ms: float,
    mass_variation_pct: float,
    cd_variation_pct: float,
    rocketpy_sem: asyncio.Semaphore,
    output_dir: str,
    use_live_weather: bool = False,
    sim_datetime: str | None = None,
    progress_callback=None,
) -> dict:
    """Run n_sims RocketPy simulations with randomized perturbations.

    Uses ProcessPoolExecutor for true parallelism — each worker is a
    separate process so LSODA's non-thread-safe Fortran COMMON blocks
    don't collide. With 10 CPU cores this gives ~6x speedup.
    """
    rng = np.random.default_rng()
    n_sims = max(10, min(n_sims, 500))

    # Resolve file paths to absolute before dispatching to subprocesses
    resolved_params = copy.deepcopy(base_params)
    for key in ("thrust_source",):
        val = resolved_params["motors"].get(key, "")
        if val and not os.path.isabs(val):
            resolved_params["motors"][key] = os.path.join(output_dir, os.path.basename(val))
    drag_val = resolved_params["rocket"].get("drag_curve", "")
    if drag_val and not os.path.isabs(drag_val):
        resolved_params["rocket"]["drag_curve"] = os.path.join(output_dir, os.path.basename(drag_val))

    # Pre-generate all perturbed parameter sets
    tasks: list[tuple] = []
    for i in range(n_sims):
        perturbed = copy.deepcopy(resolved_params)
        mass_factor = 1.0 + rng.normal(0, mass_variation_pct / 100)
        perturbed["rocket"]["mass"] = float(base_params["rocket"]["mass"]) * mass_factor
        incl_delta = rng.normal(0, wind_speed_std_ms * 0.3)
        perturbed_inclination = float(np.clip(inclination + incl_delta, 60, 89))
        perturbed_heading = heading + rng.normal(0, wind_speed_std_ms * 0.5)
        tasks.append((
            perturbed, lat, lon, elevation, rail_length,
            perturbed_inclination, perturbed_heading,
            use_live_weather, sim_datetime,
        ))

    weather_source = "NOMADS GFS" if use_live_weather else "standard_atmosphere"
    pool = _get_pool()
    loop = asyncio.get_event_loop()

    # Submit all tasks and gather results as they complete
    futures = [loop.run_in_executor(pool, _mc_flight, *t) for t in tasks]

    landings: list[dict] = []
    apogees: list[float] = []
    velocities: list[float] = []
    stabilities: list[float] = []
    n_success = 0
    completed = 0

    for fut in asyncio.as_completed(futures):
        try:
            result = await fut
            if result is not None:
                n_success += 1
                apogees.append(result["apogee_m_agl"])
                velocities.append(result["max_speed_ms"])
                stabilities.append(result["static_margin_cal"])
                if result.get("landing"):
                    landings.append(result["landing"])
        except Exception as exc:
            logger.debug("MC run failed: %s", exc)

        completed += 1
        if progress_callback:
            await progress_callback(completed, n_sims)

    return {
        "landings": landings,
        "apogee": _stats(apogees),
        "max_velocity": _stats(velocities),
        "stability": _stats(stabilities),
        "n_success": n_success,
        "n_total": n_sims,
        "weather_source": weather_source,
    }