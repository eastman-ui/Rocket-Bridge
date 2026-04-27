import logging
import os

import numpy as np

logger = logging.getLogger(__name__)


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
        import jpype
        import orhelper

        with orhelper.OpenRocketInstance(jar_path) as instance:
            orh = orhelper.Helper(instance)
            doc = orh.load_doc(ork_path)
            sim = doc.getSimulation(0)
            orh.run_simulation(sim)

            # ------------------------------------------------------------------
            # Timeseries extraction
            # ------------------------------------------------------------------
            variables = [
                orh.ALTITUDE,
                orh.VELOCITY_TOTAL,
                orh.MACH_NUMBER,
                orh.STABILITY_COEFFICIENT,
                orh.THRUST,
                orh.DRAG_COEFFICIENT,
                orh.ACCELERATION_TOTAL,
            ]
            data = orh.get_timeseries(sim, variables)

            time_arr = np.asarray(data["time"])
            alt_arr = np.asarray(data[orh.ALTITUDE])
            vel_arr = np.asarray(data[orh.VELOCITY_TOTAL])
            mach_arr = np.asarray(data[orh.MACH_NUMBER])
            stab_arr = np.asarray(data[orh.STABILITY_COEFFICIENT])
            thrust_arr = np.asarray(data[orh.THRUST])
            accel_arr = np.asarray(data[orh.ACCELERATION_TOTAL])

            # ------------------------------------------------------------------
            # Scalar values
            # ------------------------------------------------------------------
            apogee_m_agl = float(np.max(alt_arr))
            max_velocity_ms = float(np.max(vel_arr))
            max_mach = float(np.max(mach_arr))
            max_acceleration_ms2 = float(np.max(accel_arr))

            # Time to apogee: time at which altitude is maximum
            apogee_idx = int(np.argmax(alt_arr))
            time_to_apogee_s = float(time_arr[apogee_idx])

            # Stability at t=0
            stability_margin_cal = float(stab_arr[0]) if len(stab_arr) > 0 else 0.0

            # ------------------------------------------------------------------
            # Events: apogee time, burnout time, velocity off rail
            # ------------------------------------------------------------------
            events = orh.get_events(sim)

            velocity_off_rail_ms = None
            burnout_time_s = None

            for event, t_event in events:
                event_name = str(event).upper()

                if "LAUNCHROD" in event_name or "LAUNCH_ROD" in event_name or "RAIL" in event_name:
                    # Interpolate velocity at the launch rod departure time
                    if len(time_arr) > 0:
                        velocity_off_rail_ms = float(np.interp(float(t_event), time_arr, vel_arr))

                if "BURNOUT" in event_name:
                    burnout_time_s = float(t_event)

            # Fallback: if no launch rod event found, use first timestep velocity
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
