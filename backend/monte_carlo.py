"""Monte Carlo dispersion analysis via N randomized RocketPy simulations."""
import asyncio
import copy
import logging
import math
import os

import numpy as np

from simulation import run_rocketpy, _build_environment

logger = logging.getLogger(__name__)


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

    Perturbations applied per run:
    - mass: rocket["mass"] ± mass_variation_pct %
    - inclination/heading: perturbed using wind_speed_std as proxy

    When use_live_weather is True, a single GFS Environment is created
    once and reused across all iterations — no redundant NOMADS downloads.
    """
    rng = np.random.default_rng()
    n_sims = max(10, min(n_sims, 500))

    # Build environment once — reuse across all iterations
    if use_live_weather:
        async with rocketpy_sem:
            env, weather_source = await asyncio.to_thread(
                _build_environment, lat, lon, elevation, sim_datetime
            )
        logger.info("MC: shared environment ready (%s)", weather_source)
    else:
        env = None
        weather_source = "standard_atmosphere"

    landings: list[dict] = []
    apogees: list[float] = []
    velocities: list[float] = []
    stabilities: list[float] = []
    n_success = 0

    for i in range(n_sims):
        perturbed = copy.deepcopy(base_params)

        # Perturb mass
        mass_factor = 1.0 + rng.normal(0, mass_variation_pct / 100)
        perturbed["rocket"]["mass"] = float(base_params["rocket"]["mass"]) * mass_factor

        # Perturb inclination/heading (wind_speed_std as proxy for spread)
        incl_delta = rng.normal(0, wind_speed_std_ms * 0.3)
        perturbed_inclination = float(np.clip(inclination + incl_delta, 60, 89))
        perturbed_heading = heading + rng.normal(0, wind_speed_std_ms * 0.5)

        try:
            async with rocketpy_sem:
                raw = await asyncio.to_thread(
                    run_rocketpy,
                    perturbed, lat, lon, elevation, rail_length,
                    perturbed_inclination, perturbed_heading,
                    use_live_weather, output_dir,
                    sim_datetime, env,
                )

            # Landing position from trajectory end
            traj = raw.get("trajectory_3d", {})
            x_arr = traj.get("x", [])
            y_arr = traj.get("y", [])
            if x_arr and y_arr:
                land_x = x_arr[-1]
                land_y = y_arr[-1]
                land_lat = lat + land_y / 111111.0
                land_lon = lon + land_x / (111111.0 * math.cos(math.radians(lat)))
                landings.append({"lat": round(land_lat, 6), "lon": round(land_lon, 6)})

            apogees.append(raw["apogee_m_agl"])
            velocities.append(raw["max_speed_ms"])
            stabilities.append(raw["static_margin_cal"])
            n_success += 1

        except Exception as exc:
            logger.debug("MC run %d failed: %s", i, exc)

        if progress_callback:
            await progress_callback(i + 1, n_sims)

    return {
        "landings": landings,
        "apogee": _stats(apogees),
        "max_velocity": _stats(velocities),
        "stability": _stats(stabilities),
        "n_success": n_success,
        "n_total": n_sims,
        "weather_source": weather_source,
    }