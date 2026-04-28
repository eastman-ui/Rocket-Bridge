"""Motor comparison: fetch motors from ThrustCurve.org and compare performance."""
import asyncio
import copy
import logging
import os
import tempfile
from typing import Optional

import httpx

from simulation import run_rocketpy

logger = logging.getLogger(__name__)

THRUSTCURVE_SEARCH = "https://www.thrustcurve.org/api/v1/search.json"
THRUSTCURVE_DOWNLOAD = "https://www.thrustcurve.org/api/v1/download.json"


async def search_motors(query: str, limit: int = 8) -> list[dict]:
    """Search ThrustCurve.org for motors matching query string."""
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(THRUSTCURVE_SEARCH, params={"designation": query, "maxResults": limit})
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
        r = await client.post(
            THRUSTCURVE_DOWNLOAD,
            json={"motorIds": [motor_id], "data": "RASP"},
        )
        r.raise_for_status()
        results = r.json().get("results", [])
        if not results:
            return None
        files = results[0].get("files", [])
        if not files:
            return None
        return files[0].get("data")


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
) -> list[dict]:
    """Swap each motor into the rocket params and run RocketPy.

    Returns list of per-motor result dicts including designation and flight scalars.
    """
    results = []

    for motor_id in motor_ids:
        try:
            rasp = await _fetch_rasp(motor_id)
            if not rasp:
                results.append({"motor_id": motor_id, "error": "No RASP data available"})
                continue

            # Write RASP to temp file
            eng_path = os.path.join(output_dir, f"motor_{motor_id}.eng")
            with open(eng_path, "w") as f:
                f.write(rasp)

            # Extract designation from RASP header (first non-comment line)
            designation = motor_id
            for line in rasp.splitlines():
                line = line.strip()
                if line and not line.startswith(";"):
                    designation = line.split()[0]
                    break

            # Deep-copy params and swap thrust source
            swapped = copy.deepcopy(base_params)
            swapped["motors"]["thrust_source"] = eng_path
            # Clear grain geometry so simulation.py uses defaults
            for key in ("grain_number", "grain_density", "grain_outer_radius",
                        "grain_initial_inner_radius", "grain_initial_height"):
                swapped["motors"][key] = 0

            async with rocketpy_sem:
                raw = await asyncio.to_thread(
                    run_rocketpy,
                    swapped, lat, lon, elevation, rail_length, inclination, heading,
                    False, output_dir,
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
