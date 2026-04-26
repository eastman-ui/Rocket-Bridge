# RocketBridge — Developer Wiki

## Overview

RocketBridge is a web tool that accepts an OpenRocket `.ork` file, converts it to a RocketPy model, runs both simulations, and displays a side-by-side comparison of flight metrics with interactive charts and a 3D trajectory plot.

**Stack:** FastAPI (Python 3.11) backend · React/TypeScript/Vite frontend · Docker Compose

**Branch:** `weather-and-plotting` (active development branch as of 2026-04-26)

---

## Architecture

```
Browser (React/Vite :5173)
        │
        │  POST /api/simulate  (multipart .ork file + query params)
        ▼
  Nginx/Vite proxy
        │
        ▼
  FastAPI :8000  (main.py)
        │
        ├─ converter.py      → runs ork2json (Java) → parameters.json + drag/thrust CSVs
        ├─ extractor.py      → runs OpenRocket via orhelper (Java) → OR simulation results
        └─ simulation.py     → runs RocketPy → flight metrics, timeseries, KML
```

### End-to-End Request Flow

1. Frontend `POST /api/simulate` with `.ork` file and launch config query params
2. `main.py` saves `.ork` to temp dir
3. `converter.convert_ork()` calls `ork2json` subprocess → writes `parameters.json`, `thrust_source.csv`, `drag_curve.csv` (buggy — see below) to temp dir; post-processes to fix bugs
4. `extractor.extract_or_results()` calls OpenRocket via JPype/orhelper → returns OR scalar results and timeseries
5. `simulation.run_rocketpy()` builds `Environment → SolidMotor → Rocket → Flight` from the fixed params
6. Returns `ComparisonResponse` JSON; temp dir deleted

---

## File Map

```
RocketBridge/
├── Dockerfile.backend
├── docker-compose.yml
├── backend/
│   ├── main.py            API endpoints, request wiring
│   ├── models.py          Pydantic models (ComparisonResponse, ORResults, RocketPyResults)
│   ├── converter.py       .ork → parameters.json; bug fixes on rocketserializer output
│   ├── extractor.py       OpenRocket results extraction via orhelper
│   ├── simulation.py      RocketPy simulation engine
│   └── requirements.txt   rocketpy>=1.12, rocketserializer, orhelper, jpype1, ...
└── frontend/
    └── src/
        ├── App.tsx                  Top-level state, simulate handler
        ├── types.ts                 TypeScript shapes matching backend Pydantic models
        └── components/
            ├── FileUpload.tsx       .ork drag-and-drop
            ├── LaunchConfig.tsx     lat/lon/elevation/rail/inclination/heading/weather form
            ├── ComparisonTable.tsx  OR vs RocketPy metrics table with Δ% coloring
            ├── TimeSeriesCharts.tsx Altitude/velocity/Mach/stability/thrust charts (Recharts)
            └── TrajectoryPlot.tsx  3D trajectory (Plotly)
```

---

## API

### `POST /simulate`

**Query params:** `lat`, `lon`, `elevation`, `rail_length`, `inclination`, `heading`, `use_live_weather`

**Body:** `multipart/form-data` with `file` = `.ork` file

**Response:** `ComparisonResponse`

```typescript
{
  or_results: {
    apogee_m_agl?: number,
    max_velocity_ms?: number,
    max_mach?: number,
    max_acceleration_ms2?: number,
    time_to_apogee_s?: number,
    velocity_off_rail_ms?: number,
    stability_margin_cal?: number,
    timeseries?: TimeSeriesData,
  },
  rocketpy_results: {
    apogee_m_asl: number,
    apogee_m_agl: number,
    apogee_time_s: number,
    max_speed_ms: number,
    max_mach: number,
    max_acceleration_ms2: number,
    out_of_rail_velocity: number,
    static_margin_cal: number,
    static_margin_pct: number,
    burn_out_time_s: number,
    weather_source: string,
    timeseries: TimeSeriesData,
    trajectory_3d: Trajectory3D,
  },
  kml_available: boolean,
}
```

### `GET /health`
Returns `{"status": "ok"}`.

---

## Key Bugs Fixed (rocketserializer)

rocketserializer has several bugs that required workarounds. All fixes live in `converter.py` and `simulation.py`.

### 1. Wrong drag label (`converter.py: _extract_drag_from_ork`)

rocketserializer extracts `"Axial drag coefficient"` from OpenRocket simulation data. This field is a sub-component and is near-zero for most of flight. The correct field is `"Drag coefficient"` (total CD ≈ 0.61–0.77 for a typical fiberglass rocket).

**Fix:** `_extract_drag_from_ork()` re-parses the `.ork` XML using `"Drag coefficient"`, writes a corrected `drag_curve_fixed.csv`, and updates `params["rocket"]["drag_curve"]`.

### 2. Wrong rocket coordinate system (`simulation.py`)

rocketserializer exports `coordinate_system_orientation = "nose_to_tail"` in parameters.json, but `Rocket()` in RocketPy defaults to `"tail_to_nose"`. Without explicitly passing the orientation, all component positions (nose, motor, fins) are interpreted backwards. This caused wrong aerodynamics and was the root cause of fin-induced ODE stiffness (LSODA panic) in Docker.

**Fix:** `Rocket(..., coordinate_system_orientation=rkt_params.get("coordinate_system_orientation", "nose_to_tail"))`

### 3. Inertia axis swap (`simulation.py`)

rocketserializer exports inertia as `(I_roll, I_roll, I_transverse)` but RocketPy expects `(I_transverse, I_transverse, I_roll)`. For a long rocket: I_transverse ≈ 7.84 kg·m², I_roll ≈ 0.015 kg·m². Swapped values cause near-zero transverse inertia → 59 Hz pitch/yaw oscillation → LSODA requires microsecond steps → timeout.

**Fix:** Detect if `inertia[0] < inertia[2]` and swap: `(inertia[2], inertia[2], inertia[0])`.

### 4. Motor dry_mass = 0 (`converter.py: _fix_motor_dry_mass`)

rocketserializer intentionally zeroes `dry_mass` (the motor casing mass) because it can't extract `dry_inertia` from the `.ork` file. For the M2500T motor this is 3.35 kg — significant.

**Fix:** `_fix_motor_dry_mass()` extracts `min("Motor mass")` from the `.ork` simulation time series as the casing-only mass. Note: `dry_inertia` stays `(0, 0, 0)` — this is an approximation but does not cause issues in rocketpy ≥1.12.

### 5. Missing SolidMotor parameters (`simulation.py`)

`nozzle_position` (defaults to 0.0, actual value ≈ −0.3755 m) and `throat_radius` (defaults to 0.01 m, actual value ≈ 0.0245 m) were not being passed.

**Fix:** `SolidMotor(..., nozzle_position=motor_params.get("nozzle_position", 0.0), throat_radius=motor_params.get("throat_radius", 0.01), ...)`

### 6. GFS weather (dead service)

NOAA retired the GFS OpenDAP service in 2025. `use_live_weather=True` always falls back to standard atmosphere. The GFS code path is still in `simulation.py` wrapped in a try/except but is effectively dead.

---

## Validation Reference: Senior Design Rocket

The primary test rocket is the `Senior_Design_Rocket_Final_MASS_Calc.ork` (L3 cert fiberglass, AeroTech M2500T motor). After all fixes, Docker results should match:

| Metric | Target |
|--------|--------|
| Apogee AGL | ~2924 m |
| Max speed | ~271 m/s |
| Max Mach | ~0.816 |
| Apogee time | ~23.95 s |
| Burnout time | ~3.90 s |
| Stability (launch) | ~2.25 cal |
| Out-of-rail vel | ~32 m/s |
| Main chute deploy | 213 m AGL |
| Landing | ~155 s |

Motor spec (M2500T): 98mm case, 4.711 kg propellant, 3.353 kg dry mass, ~3.9 s burn, peak thrust ~3500 N.

Rocket spec: radius 70.17 mm, mass 21.524 kg (structure, no motor), inertia (7.837, 7.837, 0.015) kg·m² in RocketPy convention, nose vonKarman 0.768 m, 4 trapezoidal fins root=0.189 m tip=0.075 m span=0.114 m sweep=0.076 m at 3.230 m from nose.

---

## Known Limitations / Future Work

### Freeform fins (converter.py: `_inject_freeform_fins`)
ork2json cannot export OpenRocket freeform fin sets. `_inject_freeform_fins()` approximates them as trapezoidal fins by parsing the `.ork` XML point list. The approximation is geometrically close but not exact — fin area and moments may differ slightly.

### Stability timeseries
`simulation.py` currently broadcasts the static (t=0) stability margin as a constant across the entire flight timeseries. True stability varies with Mach and mass. To compute a real stability timeseries, use `flight.static_margin.source` from the RocketPy Flight object (available in rocketpy ≥1.12).

### KML download not implemented
`/simulate` produces a `trajectory.kml` in the temp dir and sets `kml_available=True` in the response, but there is no `GET /trajectory.kml` endpoint because the temp dir is deleted in the `finally` block. To implement: persist KML to a stable keyed path (e.g., `/tmp/jobs/{job_id}/`) and serve it via a separate endpoint.

### OR timeseries from stored results
When `extract_or_results()` fails (e.g., Java not available), the fallback `extract_or_results_from_stored()` uses the scalar stored results from the `.ork` file but returns no timeseries (OR charts remain empty). A future improvement would reconstruct an approximate timeseries from the stored simulation data in the `.ork` XML.

### `use_live_weather` / GFS
GFS is retired. Could be replaced with NOAA's newer NOMADS API or a local sounding file (RocketPy supports WindyAPI, custom soundings, etc.).

### Elliptical fins
`params["elliptical_fins"]` is parsed by rocketserializer but `simulation.py` has no handler for it. If a rocket uses elliptical fins, they will be silently ignored.

### Power-on vs power-off drag
rocketserializer provides a single drag curve; `simulation.py` uses it for both `power_off_drag` and `power_on_drag`. In practice these are nearly identical for typical fiberglass rockets, but a more accurate approach would separate them.

---

## Running Locally (without Docker)

Requires: Java 17, OpenRocket JAR at `/opt/OpenRocket-23.09.jar` (or set `OR_JAR_PATH` env var).

```bash
# Backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
OR_JAR_PATH=/path/to/OpenRocket-23.09.jar uvicorn main:app --reload --port 8000

# Frontend
cd frontend
npm install && npm run dev
```

## Running with Docker

```bash
docker compose up --build
```

The `Dockerfile.backend` installs Java 17, copies the OpenRocket JAR from `backend/OpenRocket-23.09.jar`, installs Python deps, and starts uvicorn on port 8000. Frontend runs on 5173.

---

## Parameters.json Schema (rocketserializer output)

After `converter.convert_ork()`, the `params` dict has this shape (relevant fields):

```json
{
  "motors": {
    "thrust_source": "/tmp/.../thrust_source.csv",
    "dry_mass": 3.405,
    "dry_inertia": [0, 0, 0],
    "grain_density": 1095.19,
    "grain_initial_height": 0.751,
    "grain_initial_inner_radius": 0.0245,
    "grain_number": 1,
    "grain_outer_radius": 0.049,
    "grain_separation": 0,
    "grains_center_of_mass_position": 0,
    "center_of_dry_mass_position": 0,
    "nozzle_position": -0.3755,
    "nozzle_radius": 0.036750,
    "throat_radius": 0.0245,
    "position": 3.0627,
    "coordinate_system_orientation": "nozzle_to_combustion_chamber"
  },
  "rocket": {
    "radius": 0.07017,
    "mass": 21.524,
    "inertia": [0.015, 0.015, 7.837],
    "drag_curve": "/tmp/.../drag_curve_fixed.csv",
    "center_of_mass_without_propellant": 1.988,
    "coordinate_system_orientation": "nose_to_tail"
  },
  "nosecones": {
    "length": 0.76835,
    "kind": "Von Karman",
    "position": 0.0,
    "base_radius": 0.07017
  },
  "trapezoidal_fins": {
    "0": {
      "n": 4,
      "root_chord": 0.18895,
      "tip_chord": 0.07499,
      "span": 0.1143,
      "position": 3.23041,
      "sweep_length": 0.0762
    }
  },
  "parachutes": {
    "0": {"cds": 4.086, "deploy_event": "altitude", "deploy_altitude": 213.36, "name": "main"},
    "1": {"cds": 0.880, "deploy_event": "apogee", "deploy_altitude": null, "name": "drogue"}
  },
  "stored_results": {
    "max_altitude": 3212.672,
    "time_to_apogee": 24.414,
    "max_velocity": 320.899,
    "max_mach": 0.95
  }
}
```

Note: `inertia` in parameters.json is in rocketserializer's swapped order. `simulation.py` detects and corrects this automatically.

---

## Git History (key commits)

| Hash | Description |
|------|-------------|
| `1e48a6e` | Fix 4 rocketserializer bugs: drag label, coordinate system, nozzle params, motor dry_mass |
| `713e9c4` | Fix rocketserializer inertia axis swap |
| `a4c35b3` | Eliminate fin-induced ODE stiffness; add weather_source field |
| `ef070a1` | Unit toggles, stability %, GFS fix, thrust truncation, geolocation |
| `9a66d1c` | Docker setup and rocketserializer params mapping |
| `bf45ab7` | Time-series charts |
| `68985b6` | Comparison metrics table |

Active branch: `weather-and-plotting`
