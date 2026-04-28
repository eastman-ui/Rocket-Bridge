import asyncio
import hashlib
import json
import os
import shutil
import tempfile
import logging
from typing import Optional

from fastapi import FastAPI, File, UploadFile, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from converter import convert_ork, get_stored_results, validate_ork
from extractor import extract_or_results, extract_or_results_from_stored
from simulation import run_rocketpy
from models import ComparisonResponse, HourlyLanding, ORResults, RocketParams, RocketPyResults, TimeSeriesData, Trajectory3D

OR_JAR_PATH = os.getenv("OR_JAR_PATH", "./OpenRocket-23.09.jar")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="RocketBridge API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory cache: cache_key -> serialized ComparisonResponse dict
_result_cache: dict[str, dict] = {}
_MAX_CACHE = 10

# LSODA (scipy ODE solver used by RocketPy) is not thread-safe — serialize all RocketPy calls
_rocketpy_sem = asyncio.Semaphore(1)


def _cache_put(key: str, value: dict) -> None:
    if len(_result_cache) >= _MAX_CACHE:
        del _result_cache[next(iter(_result_cache))]
    _result_cache[key] = value


_SSE_PAD = ": " + " " * 1024 + "\n"  # 1KB SSE comment — forces TCP flush on small events

def _sse(stage: str, pct: int, **extra) -> str:
    payload = json.dumps({"stage": stage, "pct": pct, **extra})
    return f"{_SSE_PAD}data: {payload}\n\n"


@app.on_event("startup")
async def startup_event():
    java_available = shutil.which("java") is not None
    logger.info("RocketBridge backend started.")
    logger.info(f"OR_JAR_PATH = {OR_JAR_PATH}")
    logger.info(f"Java available: {java_available}")


@app.get("/health")
def health():
    return {"status": "ok"}


def _extract_rocket_params(params: dict) -> dict:
    import math
    rkt = params.get("rocket", {})
    motor = params.get("motors", {})

    radius = float(rkt.get("radius", 0))
    rocket_dry = float(rkt.get("mass", 0))
    motor_dry = float(motor.get("dry_mass", 0))

    try:
        grain_count = int(motor.get("grain_number", 0))
        grain_density = float(motor.get("grain_density", 0))
        ro = float(motor.get("grain_outer_radius", 0))
        ri = float(motor.get("grain_initial_inner_radius", 0))
        h = float(motor.get("grain_initial_height", 0))
        propellant_mass = grain_count * grain_density * math.pi * (ro ** 2 - ri ** 2) * h
    except Exception:
        propellant_mass = 0.0

    motor_pos = float(motor.get("position", 0))
    nozzle_pos = float(motor.get("nozzle_position", 0))
    length_m = motor_pos + abs(nozzle_pos) if motor_pos > 0 else 0.0

    motor_designation = motor.get("designation", "")
    if not motor_designation:
        thrust_src = str(motor.get("thrust_source", ""))
        motor_designation = os.path.splitext(os.path.basename(thrust_src))[0]

    fins_raw = params.get("trapezoidal_fins", {})
    fin_list = list(fins_raw.values()) if isinstance(fins_raw, dict) else fins_raw
    fin_count = sum(int(f.get("n", f.get("number", f.get("count", 0)))) for f in fin_list) if fin_list else 0

    chutes_raw = params.get("parachutes", {})
    chute_list = list(chutes_raw.values()) if isinstance(chutes_raw, dict) else chutes_raw

    return {
        "motor_designation": motor_designation,
        "length_m": round(length_m, 3),
        "diameter_m": round(2.0 * radius, 4),
        "wet_mass_kg": round(rocket_dry + motor_dry + propellant_mass, 3),
        "dry_mass_kg": round(rocket_dry + motor_dry, 3),
        "propellant_mass_kg": round(propellant_mass, 3),
        "motor_dry_mass_kg": round(motor_dry, 3),
        "fin_count": fin_count,
        "parachute_count": len(chute_list),
    }


def _build_response(
    or_results_raw: dict,
    rocketpy_raw: dict,
    rocket_params: RocketParams,
    ork_warnings: list[str],
) -> ComparisonResponse:
    ts_raw = or_results_raw.get("timeseries")
    timeseries_or = TimeSeriesData(**ts_raw) if ts_raw is not None else None

    or_results = ORResults(
        apogee_m_agl=or_results_raw.get("apogee_m_agl"),
        max_velocity_ms=or_results_raw.get("max_velocity_ms"),
        max_mach=or_results_raw.get("max_mach"),
        max_acceleration_ms2=or_results_raw.get("max_acceleration_ms2"),
        time_to_apogee_s=or_results_raw.get("time_to_apogee_s"),
        velocity_off_rail_ms=or_results_raw.get("velocity_off_rail_ms"),
        stability_margin_cal=or_results_raw.get("stability_margin_cal"),
        timeseries=timeseries_or,
        or_launch_rod_length_m=or_results_raw.get("or_launch_rod_length_m"),
    )

    rocketpy_results = RocketPyResults(
        apogee_m_asl=rocketpy_raw["apogee_m_asl"],
        apogee_m_agl=rocketpy_raw["apogee_m_agl"],
        apogee_time_s=rocketpy_raw["apogee_time_s"],
        max_speed_ms=rocketpy_raw["max_speed_ms"],
        max_mach=rocketpy_raw["max_mach"],
        max_acceleration_ms2=rocketpy_raw["max_acceleration_ms2"],
        out_of_rail_velocity=rocketpy_raw["out_of_rail_velocity"],
        static_margin_cal=rocketpy_raw["static_margin_cal"],
        static_margin_pct=rocketpy_raw["static_margin_pct"],
        burn_out_time_s=rocketpy_raw["burn_out_time_s"],
        weather_source=rocketpy_raw["weather_source"],
        timeseries=TimeSeriesData(**rocketpy_raw["timeseries"]),
        trajectory_3d=Trajectory3D(**rocketpy_raw["trajectory_3d"]),
        launch_lat=rocketpy_raw["launch_lat"],
        launch_lon=rocketpy_raw["launch_lon"],
        launch_elevation_m=rocketpy_raw["launch_elevation_m"],
    )

    return ComparisonResponse(
        or_results=or_results,
        rocketpy_results=rocketpy_results,
        kml_available=rocketpy_raw.get("kml_data") is not None,
        kml_data=rocketpy_raw.get("kml_data"),
        rocket_params=rocket_params,
        rocket_diagram=rocketpy_raw.get("rocket_diagram"),
        hourly_landings=[HourlyLanding(**h) for h in rocketpy_raw.get("hourly_landings", [])],
        warnings=ork_warnings,
    )


@app.post("/simulate")
async def simulate(
    file: UploadFile = File(...),
    lat: float = Query(32.99),
    lon: float = Query(-106.97),
    elevation: float = Query(1400.0),
    rail_length: float = Query(5.2),
    inclination: float = Query(85.0),
    heading: float = Query(0.0),
    use_live_weather: bool = Query(False),
    sim_datetime: Optional[str] = Query(None),
):
    if not file.filename or not file.filename.endswith(".ork"):
        raise HTTPException(status_code=400, detail="File must be .ork")

    contents = await file.read()
    filename = file.filename

    async def generate():
        tmp_dir = tempfile.mkdtemp()
        try:
            # Cache check
            file_hash = hashlib.sha256(contents).hexdigest()
            cache_key = f"{file_hash}:{lat}:{lon}:{elevation}:{rail_length}:{inclination}:{heading}:{use_live_weather}:{sim_datetime or ''}"
            if cache_key in _result_cache:
                logger.info("Cache hit for %s", file_hash[:8])
                yield _sse("done", 100, result=_result_cache[cache_key], cached=True)
                return

            # Save file
            ork_path = os.path.join(tmp_dir, filename)
            with open(ork_path, "wb") as f:
                f.write(contents)

            # Validate
            yield _sse("validating", 8)
            ork_warnings = await asyncio.to_thread(validate_ork, ork_path)
            for w in ork_warnings:
                logger.warning("ORK validation: %s", w)

            # Convert
            yield _sse("converting", 20)
            params = await asyncio.to_thread(convert_ork, ork_path, tmp_dir)
            rocket_params = RocketParams(**_extract_rocket_params(params))

            # Run OR extraction and RocketPy in parallel
            yield _sse("simulating", 45)

            async def _run_or() -> dict:
                try:
                    return await asyncio.to_thread(extract_or_results, ork_path, OR_JAR_PATH)
                except Exception as e:
                    logger.warning("extract_or_results failed (%s); falling back to stored results.", e)
                    stored = get_stored_results(params)
                    return extract_or_results_from_stored(stored)

            async def _run_rocketpy() -> dict:
                async with _rocketpy_sem:
                    raw = await asyncio.to_thread(
                        run_rocketpy,
                        params, lat, lon, elevation, rail_length,
                        inclination, heading, use_live_weather, tmp_dir,
                        sim_datetime=sim_datetime,
                    )
                kml_path = os.path.join(tmp_dir, "trajectory.kml")
                if os.path.exists(kml_path):
                    try:
                        with open(kml_path) as kf:
                            raw["kml_data"] = kf.read()
                    except Exception as e:
                        logger.warning("Could not read KML: %s", e)
                return raw

            # Kick off both tasks and send heartbeats while waiting
            combined = asyncio.ensure_future(
                asyncio.gather(_run_or(), _run_rocketpy(), return_exceptions=True)
            )
            pct = 45
            while not combined.done():
                await asyncio.sleep(3)
                if not combined.done():
                    pct = min(pct + 2, 90)
                    yield _sse("simulating", int(pct))

            results = combined.result()
            for r in results:
                if isinstance(r, Exception):
                    raise r
            or_results_raw, rocketpy_raw = results

            # Build and cache response
            yield _sse("building", 95)
            response = _build_response(or_results_raw, rocketpy_raw, rocket_params, ork_warnings)
            result_dict = response.model_dump()
            _cache_put(cache_key, result_dict)

            yield _sse("done", 100, result=result_dict)

        except Exception as exc:
            logger.exception("Simulation error")
            yield _sse("error", 0, message=str(exc))
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# TODO: GET /trajectory.kml — not feasible as implemented because temp files are
# deleted in the finally block of /simulate before a follow-up request could
# retrieve them. To support this endpoint, the simulation output would need to be
# persisted to a stable location (e.g., keyed by a job ID) and served from there.
