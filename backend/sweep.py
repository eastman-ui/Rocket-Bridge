"""Parameter sweep: run N RocketPy simulations varying a single launch parameter."""
import asyncio
import logging
from typing import Literal

from simulation import run_rocketpy

logger = logging.getLogger(__name__)

SweepParam = Literal["inclination", "rail_length", "heading", "elevation"]


async def run_sweep(
    params: dict,
    lat: float,
    lon: float,
    elevation: float,
    rail_length: float,
    inclination: float,
    heading: float,
    sweep_param: SweepParam,
    sweep_min: float,
    sweep_max: float,
    sweep_steps: int,
    rocketpy_sem: asyncio.Semaphore,
    output_dir: str,
) -> list[dict]:
    """Run sweep_steps simulations varying sweep_param from sweep_min to sweep_max.

    Returns list of { param_value, apogee_m_agl, max_speed_ms, max_mach,
                       stability_cal, off_rail_velocity } dicts.
    """
    steps = max(2, min(sweep_steps, 20))
    values = [
        sweep_min + (sweep_max - sweep_min) * i / (steps - 1)
        for i in range(steps)
    ]

    results = []
    for v in values:
        kwargs = dict(
            lat=lat,
            lon=lon,
            elevation=elevation,
            rail_length=rail_length,
            inclination=inclination,
            heading=heading,
        )
        kwargs[sweep_param] = v  # type: ignore[assignment]

        try:
            async with rocketpy_sem:
                raw = await asyncio.to_thread(
                    run_rocketpy,
                    params,
                    kwargs["lat"],
                    kwargs["lon"],
                    kwargs["elevation"],
                    kwargs["rail_length"],
                    kwargs["inclination"],
                    kwargs["heading"],
                    False,
                    output_dir,
                )
            results.append({
                "param_value": round(v, 4),
                "apogee_m_agl": raw["apogee_m_agl"],
                "max_speed_ms": raw["max_speed_ms"],
                "max_mach": raw["max_mach"],
                "stability_cal": raw["static_margin_cal"],
                "off_rail_velocity": raw["out_of_rail_velocity"],
            })
        except Exception as exc:
            logger.warning("sweep step %s=%s failed: %s", sweep_param, v, exc)
            results.append({"param_value": round(v, 4), "error": str(exc)})

    return results
