import os
import shutil
import tempfile
import logging

from fastapi import FastAPI, File, UploadFile, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from converter import convert_ork, get_stored_results
from extractor import extract_or_results, extract_or_results_from_stored
from simulation import run_rocketpy
from models import ComparisonResponse, ORResults, RocketParams, RocketPyResults, TimeSeriesData, Trajectory3D

# Path to OpenRocket JAR — user sets this via env var or config
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

    thrust_src = str(motor.get("thrust_source", ""))
    motor_designation = os.path.splitext(os.path.basename(thrust_src))[0]

    fins_raw = params.get("trapezoidal_fins", {})
    fin_list = list(fins_raw.values()) if isinstance(fins_raw, dict) else fins_raw
    fin_count = sum(int(f.get("n", 0)) for f in fin_list) if fin_list else 0

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


@app.post("/simulate", response_model=ComparisonResponse)
async def simulate(
    file: UploadFile = File(...),
    lat: float = Query(32.99),
    lon: float = Query(-106.97),
    elevation: float = Query(1400.0),
    rail_length: float = Query(5.2),
    inclination: float = Query(85.0),
    heading: float = Query(0.0),
    use_live_weather: bool = Query(False),
):
    # Validate file extension
    if not file.filename or not file.filename.endswith(".ork"):
        raise HTTPException(status_code=400, detail="File must be .ork")

    tmp_dir = tempfile.mkdtemp()
    try:
        # Save uploaded file to temp directory
        ork_path = os.path.join(tmp_dir, file.filename)
        contents = await file.read()
        with open(ork_path, "wb") as f:
            f.write(contents)

        # Step 1: Convert ORK to RocketPy params
        params = convert_ork(ork_path, tmp_dir)
        rocket_params = RocketParams(**_extract_rocket_params(params))

        # Step 2: Extract OpenRocket simulation results, with fallback
        try:
            or_results_raw = extract_or_results(ork_path, OR_JAR_PATH)
        except Exception as e:
            logger.warning(
                f"extract_or_results failed ({e}); falling back to stored results."
            )
            stored = get_stored_results(params)
            or_results_raw = extract_or_results_from_stored(stored)

        # Step 3: Run RocketPy simulation
        rocketpy_raw = run_rocketpy(
            params,
            lat,
            lon,
            elevation,
            rail_length,
            inclination,
            heading,
            use_live_weather,
            tmp_dir,
        )

        # Step 4: Build ORResults
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
        )

        # Step 5: Build RocketPyResults
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
        )

        # Step 6: Check for KML output
        kml_available = os.path.exists(os.path.join(tmp_dir, "trajectory.kml"))

        return ComparisonResponse(
            or_results=or_results,
            rocketpy_results=rocketpy_results,
            kml_available=kml_available,
            rocket_params=rocket_params,
            rocket_diagram=rocketpy_raw.get("rocket_diagram"),
        )

    except HTTPException:
        raise
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        logger.exception("Unhandled simulation error")
        raise HTTPException(status_code=500, detail="Simulation failed: " + str(e))
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


# TODO: GET /trajectory.kml — not feasible as implemented because temp files are
# deleted in the finally block of /simulate before a follow-up request could
# retrieve them. To support this endpoint, the simulation output would need to be
# persisted to a stable location (e.g., keyed by a job ID) and served from there.
