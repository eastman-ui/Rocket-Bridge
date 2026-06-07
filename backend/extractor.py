import json
import logging
import multiprocessing
import os
import sys

import numpy as np

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Subprocess isolation: JPype/JVM loads libhdf5, which is NOT thread-safe and
# conflicts with RocketPy's netCDF4 (also uses libhdf5).  Running OR extraction
# in a subprocess ensures the JVM's HDF5 state never overlaps with RocketPy's.
# ---------------------------------------------------------------------------


def _run_in_subprocess(
    ork_path: str,
    jar_path: str,
    result_queue,
    sim_index: int = 0,
    launch_lat: float | None = None,
    launch_lon: float | None = None,
    launch_alt_m: float | None = None,
) -> None:
    """Worker function executed in a subprocess.  Starts a fresh JVM, runs
    OpenRocket extraction, puts the result dict on the queue, then exits
    (which cleanly shuts down the JVM)."""
    try:
        import jpype
        import orhelper

        # Inside a subprocess we own the JVM — no need for singleton tricks.
        instance = orhelper.OpenRocketInstance(jar_path)
        instance.__enter__()
        try:
            orh = orhelper.Helper(instance)
            fdt = orhelper.FlightDataType

            logger.info("OR extract (subprocess): loading doc %s", ork_path)
            doc = orh.load_doc(ork_path)
            sim = doc.getSimulation(sim_index)

            # Override launch site conditions so OR uses the same site as RocketPy
            opts = sim.getOptions()
            if launch_lat is not None:
                opts.setLaunchLatitude(launch_lat)
            if launch_lon is not None:
                opts.setLaunchLongitude(launch_lon)
            if launch_alt_m is not None:
                opts.setLaunchAltitude(launch_alt_m)
                logger.info(
                    "OR extract (subprocess): launch site set to lat=%.4f lon=%.4f alt=%.1f m",
                    launch_lat, launch_lon, launch_alt_m,
                )

            logger.info("OR extract (subprocess): running simulation [index %d]", sim_index)
            orh.run_simulation(sim)
            logger.info("OR extract (subprocess): simulation done, fetching timeseries")

            variables = [
                fdt.TYPE_TIME,
                fdt.TYPE_ALTITUDE,
                fdt.TYPE_VELOCITY_TOTAL,
                fdt.TYPE_MACH_NUMBER,
                fdt.TYPE_STABILITY,
                fdt.TYPE_THRUST_FORCE,
                fdt.TYPE_DRAG_COEFF,
                fdt.TYPE_ACCELERATION_TOTAL,
            ]
            data = orh.get_timeseries(sim, variables)
            logger.info("OR extract (subprocess): timeseries fetched, getting events")

            time_arr = np.asarray(data[fdt.TYPE_TIME])
            alt_arr = np.asarray(data[fdt.TYPE_ALTITUDE])
            vel_arr = np.asarray(data[fdt.TYPE_VELOCITY_TOTAL])
            mach_arr = np.asarray(data[fdt.TYPE_MACH_NUMBER])
            stab_arr = np.asarray(data[fdt.TYPE_STABILITY])
            thrust_arr = np.asarray(data[fdt.TYPE_THRUST_FORCE])
            drag_coeff_arr = np.asarray(data[fdt.TYPE_DRAG_COEFF])
            accel_arr = np.asarray(data[fdt.TYPE_ACCELERATION_TOTAL])

            apogee_m_agl = float(np.max(alt_arr))
            max_velocity_ms = float(np.max(vel_arr))
            max_mach = float(np.max(mach_arr))
            max_acceleration_ms2 = float(np.max(accel_arr))

            apogee_idx = int(np.argmax(alt_arr))
            time_to_apogee_s = float(time_arr[apogee_idx])
            # First timestep is often NaN (before aerodynamic calc), skip to first valid value
            non_nan_stab = stab_arr[~np.isnan(stab_arr)]
            stability_margin_cal = float(non_nan_stab[0]) if len(non_nan_stab) > 0 else 0.0

            # Stability at Mach 0.3 — fair comparison point between simulators
            stability_margin_mach03_cal = None
            if len(mach_arr) > 0 and len(stab_arr) > 0:
                valid = ~np.isnan(stab_arr) & ~np.isnan(mach_arr)
                if np.any(valid):
                    mv, sv = mach_arr[valid], stab_arr[valid]
                    # Need monotonically increasing mach for interp; sort by mach
                    order = np.argsort(mv)
                    mv, sv = mv[order], sv[order]
                    if mv[0] <= 0.3 <= mv[-1]:
                        stability_margin_mach03_cal = float(np.interp(0.3, mv, sv))

            events = orh.get_events(sim)
            logger.info("OR extract (subprocess): events fetched (%d types)", len(events))
            velocity_off_rail_ms = None

            for event, times in events.items():
                event_name = str(event).upper()
                t_event = times[0]
                if "LAUNCHROD" in event_name or "LAUNCH_ROD" in event_name or "RAIL" in event_name:
                    if len(time_arr) > 0:
                        velocity_off_rail_ms = float(np.interp(float(t_event), time_arr, vel_arr))
                if "BURNOUT" in event_name:
                    pass  # burnout_time_s not needed in subprocess result

            if velocity_off_rail_ms is None and len(vel_arr) > 0:
                velocity_off_rail_ms = float(vel_arr[0])

            step = max(1, len(time_arr) // 500)
            timeseries = {
                "time": time_arr[::step].tolist(),
                "altitude": alt_arr[::step].tolist(),
                "velocity": vel_arr[::step].tolist(),
                "mach": mach_arr[::step].tolist(),
                "stability": stab_arr[::step].tolist(),
                "thrust": thrust_arr[::step].tolist(),
                "drag_coeff": drag_coeff_arr[::step].tolist(),
            }

            result_queue.put({
                "ok": True,
                "data": {
                    "apogee_m_agl": apogee_m_agl,
                    "max_velocity_ms": max_velocity_ms,
                    "max_mach": max_mach,
                    "max_acceleration_ms2": max_acceleration_ms2,
                    "time_to_apogee_s": time_to_apogee_s,
                    "velocity_off_rail_ms": velocity_off_rail_ms,
                    "stability_margin_cal": stability_margin_cal,
                    "stability_margin_mach03_cal": stability_margin_mach03_cal,
                    "main_descent_speed_ms": None,
                    "drogue_descent_speed_ms": None,
                    "timeseries": timeseries,
                },
            })
        finally:
            instance.__exit__(None, None, None)

    except Exception as exc:
        logger.exception("OR extract (subprocess) failed: %s", exc)
        result_queue.put({"ok": False, "error": str(exc)})


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def extract_or_results(
    ork_path: str,
    jar_path: str,
    sim_index: int = 0,
    launch_lat: float | None = None,
    launch_lon: float | None = None,
    launch_alt_m: float | None = None,
) -> dict:
    """Extract OR simulation results in an isolated subprocess.

    Running in a subprocess ensures the JPype/JVM (which loads libhdf5) never
    coexists in the same process as RocketPy's netCDF4 (which also uses
    libhdf5).  Without isolation, concurrent HDF5 access causes SIGSEGV.

    sim_index selects which OR simulation to run (0-based, matches ORK order).
    launch_lat/lon/alt_m override the stored launch site so OR uses the same
    conditions as RocketPy.
    """
    if not os.path.exists(ork_path):
        raise FileNotFoundError(f"OpenRocket file not found: {ork_path}")
    if not os.path.exists(jar_path):
        raise FileNotFoundError(f"OpenRocket JAR not found at {jar_path}")

    ctx = multiprocessing.get_context("spawn")
    result_queue = ctx.Queue()
    proc = ctx.Process(
        target=_run_in_subprocess,
        args=(ork_path, jar_path, result_queue, sim_index, launch_lat, launch_lon, launch_alt_m),
    )
    proc.start()
    proc.join(timeout=120)

    if proc.is_alive():
        logger.warning("OR extract subprocess timed out after 120s — killing")
        proc.kill()
        proc.join(timeout=5)
        raise RuntimeError("OpenRocket extraction timed out after 120 seconds")

    result = result_queue.get_nowait()

    if result["ok"]:
        logger.info("OR extract (subprocess): completed successfully")
        return result["data"]
    else:
        raise RuntimeError(result["error"])


def extract_or_results_from_stored(stored_results: dict) -> dict:
    """Fallback extractor that reads scalar values from a pre-stored results dict.

    Used when orhelper/JPype is unavailable or the .ork live simulation fails.
    Returns the same shape as extract_or_results but with None for unknowns
    and no timeseries.
    """
    def _find(d: dict, *candidates) -> float | None:
        """Case-insensitive key lookup across multiple candidate names."""
        normalized = {k.lower().replace("-", "_").replace(" ", "_"): v for k, v in d.items()}
        for c in candidates:
            val = normalized.get(c.lower())
            if val is not None:
                try:
                    return float(val)
                except (TypeError, ValueError):
                    pass
        return None

    apogee_m_agl = _find(
        stored_results,
        "apogee", "max_altitude", "maxaltitude", "apogee_m_agl", "apogee_agl",
    )
    max_velocity_ms = _find(
        stored_results,
        "max_velocity", "maxvelocity", "max_velocity_ms", "max_speed", "maxspeed",
    )
    max_mach = _find(
        stored_results,
        "max_mach", "maxmach", "mach_max", "max_mach_number",
    )
    max_acceleration_ms2 = _find(
        stored_results,
        "max_acceleration", "maxacceleration", "max_acceleration_ms2",
    )
    time_to_apogee_s = _find(
        stored_results,
        "time_to_apogee", "timetoapogee", "apogee_time", "time_to_apogee_s",
    )
    velocity_off_rail_ms = _find(
        stored_results,
        "velocity_off_rail", "velocityoffrail", "rail_velocity", "off_rail_velocity",
        "velocity_off_rail_ms", "launch_rod_velocity", "launchrodvelocity",
    )
    # Prefer at-launch stability (extracted from .ork datapoints) over burnout value
    stability_margin_cal = _find(
        stored_results,
        "launch_stability_margin",
        "stability", "stability_margin", "stability_margin_cal", "stability_coefficient",
        "min_stability_margin", "burnout_stability_margin", "max_stability_margin",
    )

    timeseries = stored_results.get("or_timeseries")
    or_launch_rod_length_m = _find(stored_results, "or_launch_rod_length_m")

    return {
        "apogee_m_agl": apogee_m_agl,
        "max_velocity_ms": max_velocity_ms,
        "max_mach": max_mach,
        "max_acceleration_ms2": max_acceleration_ms2,
        "time_to_apogee_s": time_to_apogee_s,
        "velocity_off_rail_ms": velocity_off_rail_ms,
        "stability_margin_cal": stability_margin_cal,
        "stability_margin_mach03_cal": None,  # not available from stored results
        "main_descent_speed_ms": _find(stored_results, "main_descent_speed", "main_descent_speed_ms", "landing_velocity", "descent_rate"),
        "drogue_descent_speed_ms": _find(stored_results, "drogue_descent_speed", "drogue_descent_speed_ms", "drogue_rate"),
        "timeseries": timeseries,
        "or_launch_rod_length_m": or_launch_rod_length_m,
    }