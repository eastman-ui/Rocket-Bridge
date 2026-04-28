"""Motor comparison: fetch motors from ThrustCurve.org and compare performance."""
import asyncio
import base64
import copy
import logging
import os
import tempfile
from typing import Optional

import httpx

from simulation import run_rocketpy, _build_environment

logger = logging.getLogger(__name__)

THRUSTCURVE_SEARCH = "https://www.thrustcurve.org/api/v1/search.json"
THRUSTCURVE_DOWNLOAD = "https://www.thrustcurve.org/api/v1/download.json"


async def search_motors(query: str, limit: int = 8) -> list[dict]:
    """Search ThrustCurve.org for motors matching query string."""
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(THRUSTCURVE_SEARCH, params={"commonName": query, "maxResults": limit})
        r.raise_for_status()
        data = r.json()
        return [
            {
                "id": m["motorId"],
                "designation": m.get("designation", ""),
                "manufacturer": m.get("manufacturer", ""),
                "impulse_class": m.get("impulseClass", ""),
                "avg_thrust_n": m.get("avgThrustN"),
                "total_impulse_ns": m.get("totImpulseNs"),
            }
            for m in data.get("results", [])
        ]


async def _fetch_rasp(motor_id: str) -> Optional[str]:
    """Download RASP .eng content for a motor from ThrustCurve.org."""
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            THRUSTCURVE_DOWNLOAD,
            params={"motorId": motor_id, "format": "RASP"},
        )
        r.raise_for_status()
        results = r.json().get("results", [])
        if not results:
            return None
        raw = results[0].get("data")
        if not raw:
            return None
        try:
            return base64.b64decode(raw).decode("latin-1")
        except Exception:
            return raw


async def compare_motors(
    base_params: dict,
    motor_ids: list[str],
    lat: float,
    lon: float,
    elevation: float,
    rail_length: float,
    inclination: float,
    heading: float,
    rocketpy_sem: asyncio.Semaphore,
    output_dir: str,
    use_live_weather: bool = False,
    sim_datetime: Optional[str] = None,
) -> list[dict]:
    """Swap each motor into the rocket params and run RocketPy.

    When use_live_weather is True, a single GFS Environment is created
    once and reused across all motor iterations.
    """
    if use_live_weather:
        async with rocketpy_sem:
            env, weather_source = await asyncio.to_thread(
                _build_environment, lat, lon, elevation, sim_datetime
            )
        logger.info("Motor compare: shared environment ready (%s)", weather_source)
    else:
        env = None

    results = []

    for motor_id in motor_ids:
        try:
            rasp = await _fetch_rasp(motor_id)
            if not rasp:
                results.append({"motor_id": motor_id, "error": "No RASP data available"})
                continue

            eng_path = os.path.join(output_dir, f"motor_{motor_id}.eng")
            with open(eng_path, "w") as f:
                f.write(rasp)

            designation = motor_id
            for line in rasp.splitlines():
                line = line.strip()
                if line and not line.startswith(";"):
                    designation = line.split()[0]
                    break

            swapped = copy.deepcopy(base_params)
            swapped["motors"]["thrust_source"] = eng_path
            for key in ("grain_number", "grain_density", "grain_outer_radius",
                        "grain_initial_inner_radius", "grain_initial_height"):
                swapped["motors"][key] = 0

            async with rocketpy_sem:
                raw = await asyncio.to_thread(
                    run_rocketpy,
                    swapped, lat, lon, elevation, rail_length, inclination, heading,
                    use_live_weather, output_dir, sim_datetime, env,
                )

            results.append({
                "motor_id": motor_id,
                "designation": designation,
                "apogee_m_agl": raw["apogee_m_agl"],
                "max_speed_ms": raw["max_speed_ms"],
                "max_mach": raw["max_mach"],
                "stability_cal": raw["static_margin_cal"],
                "off_rail_velocity": raw["out_of_rail_velocity"],
                "burn_out_time_s": raw["burn_out_time_s"],
            })

        except Exception as exc:
            logger.warning("motor compare %s failed: %s", motor_id, exc)
            results.append({"motor_id": motor_id, "error": str(exc)})

    return results