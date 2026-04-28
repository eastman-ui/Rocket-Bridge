import logging
import os
import threading

import numpy as np

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# JPype / OpenRocket singleton
#
# jpype.shutdownJVM() must be called from the main thread (JPype 1.x restriction),
# but extract_or_results() runs inside asyncio.to_thread() — a threadpool worker.
# Fix: start the JVM once and keep it alive for the process lifetime.
# Never call shutdownJVM; the OS reclaims the JVM when the process exits.
# ---------------------------------------------------------------------------

_or_lock = threading.Lock()
_or_helper = None   # orhelper.Helper, reused across all calls
_or_fdt = None      # orhelper.FlightDataType, cached after first import


def _ensure_or_started(jar_path: str):
    """Return a persistent orhelper.Helper, starting the JVM on first call."""
    global _or_helper, _or_fdt
    if _or_helper is not None:
        return _or_helper, _or_fdt
    with _or_lock:
        if _or_helper is not None:
            return _or_helper, _or_fdt
        import jpype
        import orhelper
        # Patch shutdownJVM to a no-op before __enter__ so the context manager
        # cannot shut down the JVM from a worker thread on __exit__.
        jpype.shutdownJVM = lambda: None
        instance = orhelper.OpenRocketInstance(jar_path)
        instance.__enter__()
        # Deliberately do NOT call instance.__exit__() — JVM stays alive.
        _or_helper = orhelper.Helper(instance)
        _or_fdt = orhelper.FlightDataType
        logger.info("OpenRocket JVM started (persistent singleton).")
    return _or_helper, _or_fdt


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _downsample(arr, max_pts: int = 500):
    """Downsample a 1-D numpy array or list to at most max_pts points."""
    arr = np.asarray(arr)
    if len(arr) <= max_pts:
        return arr.tolist()
    step = max(1, len(arr) // max_pts)
    return arr[::step].tolist()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def extract_or_results(ork_path: str, jar_path: str) -> dict:
    """Extract OR simulation results via orhelper/JPype. Returns scalar summary + timeseries.

    Args:
        ork_path: Path to the .ork OpenRocket file.
        jar_path: Path to the OpenRocket JAR (e.g. OpenRocket-15.03.jar).

    Returns:
        Dict with scalar flight summary values and a downsampled timeseries.

    Raises:
        FileNotFoundError: If ork_path or jar_path do not exist.
        RuntimeError: If the simulation fails for any reason.
    """
    if not os.path.exists(ork_path):
        raise FileNotFoundError(f"OpenRocket file not found: {ork_path}")
    if not os.path.exists(jar_path):
        raise FileNotFoundError(f"OpenRocket JAR not found at {jar_path}")

    try:
        orh, fdt = _ensure_or_started(jar_path)
        doc = orh.load_doc(ork_path)
        sim = doc.getSimulation(0)
        orh.run_simulation(sim)

        # ------------------------------------------------------------------
        # Timeseries extraction
        # ------------------------------------------------------------------
        variables = [
            fdt.TYPE_ALTITUDE,
            fdt.TYPE_VELOCITY_TOTAL,
            fdt.TYPE_MACH_NUMBER,
            fdt.TYPE_STABILITY,
            fdt.TYPE_THRUST_FORCE,
            fdt.TYPE_DRAG_COEFF,
            fdt.TYPE_ACCELERATION_TOTAL,
        ]
        data = orh.get_timeseries(sim, variables)

        time_arr = np.asarray(data["time"])
        alt_arr = np.asarray(data[fdt.TYPE_ALTITUDE])
        vel_arr = np.asarray(data[fdt.TYPE_VELOCITY_TOTAL])
        mach_arr = np.asarray(data[fdt.TYPE_MACH_NUMBER])
        stab_arr = np.asarray(data[fdt.TYPE_STABILITY])
        thrust_arr = np.asarray(data[fdt.TYPE_THRUST_FORCE])
        accel_arr = np.asarray(data[fdt.TYPE_ACCELERATION_TOTAL])

        # ------------------------------------------------------------------
        # Scalar values
        # ------------------------------------------------------------------
        apogee_m_agl = float(np.max(alt_arr))
        max_velocity_ms = float(np.max(vel_arr))
        max_mach = float(np.max(mach_arr))
        max_acceleration_ms2 = float(np.max(accel_arr))

        apogee_idx = int(np.argmax(alt_arr))
        time_to_apogee_s = float(time_arr[apogee_idx])
        stability_margin_cal = float(stab_arr[0]) if len(stab_arr) > 0 else 0.0

        # ------------------------------------------------------------------
        # Events: burnout time, velocity off rail
        # ------------------------------------------------------------------
        events = orh.get_events(sim)
        velocity_off_rail_ms = None
        burnout_time_s = None

        for event, t_event in events:
            event_name = str(event).upper()
            if "LAUNCHROD" in event_name or "LAUNCH_ROD" in event_name or "RAIL" in event_name:
                if len(time_arr) > 0:
                    velocity_off_rail_ms = float(np.interp(float(t_event), time_arr, vel_arr))
            if "BURNOUT" in event_name:
                burnout_time_s = float(t_event)

        if velocity_off_rail_ms is None and len(vel_arr) > 0:
            velocity_off_rail_ms = float(vel_arr[0])

        # ------------------------------------------------------------------
        # Downsampled timeseries (max 500 points)
        # ------------------------------------------------------------------
        step = max(1, len(time_arr) // 500)
        timeseries = {
            "time": time_arr[::step].tolist(),
            "altitude": alt_arr[::step].tolist(),
            "velocity": vel_arr[::step].tolist(),
            "mach": mach_arr[::step].tolist(),
            "stability": stab_arr[::step].tolist(),
            "thrust": thrust_arr[::step].tolist(),
        }

    except (FileNotFoundError, RuntimeError):
        raise
    except Exception as exc:
        logger.exception("OpenRocket extraction failed: %s", exc)
        raise RuntimeError(
            f"OpenRocket simulation failed: {exc}. "
            "Check that the JAR path is correct and the .ork file is valid."
        ) from exc

    return {
        "apogee_m_agl": apogee_m_agl,
        "max_velocity_ms": max_velocity_ms,
        "max_mach": max_mach,
        "max_acceleration_ms2": max_acceleration_ms2,
        "time_to_apogee_s": time_to_apogee_s,
        "velocity_off_rail_ms": velocity_off_rail_ms,
        "stability_margin_cal": stability_margin_cal,
        "timeseries": timeseries,
    }


def extract_or_results_from_stored(stored_results: dict) -> dict:
    """Fallback extractor that reads scalar values from a pre-stored results dict.

    Used when orhelper/JPype is unavailable or the .ork live simulation fails.
    Returns the same shape as extract_or_results but with None for unknowns
    and no timeseries.

    Args:
        stored_results: Dict from parameters.json["stored_results"] (or similar).

    Returns:
        Dict matching the ORResults schema, with timeseries set to None.
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
        "timeseries": timeseries,
        "or_launch_rod_length_m": or_launch_rod_length_m,
    }
