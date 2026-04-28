# RocketBridge

RocketBridge bridges OpenRocket and RocketPy. Upload a `.ork` file, configure your launch site, and RocketBridge runs both simulators in parallel — returning a side-by-side comparison of key flight metrics, interactive time-series charts, a 3D trajectory, satellite map overlay, rocket orientation animation, and a downloadable KML file for Google Earth.

## Quick Start (Docker — recommended)

Docker handles all dependencies automatically, including Java 17 and the OpenRocket JAR.

**Prerequisites:** [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Mac/Windows/Linux)

```bash
git clone https://github.com/eastman-ui/Rocket-Bridge.git
cd Rocket-Bridge
docker compose up --build
```

Open **http://localhost:5175** — that's it.

> First build takes 2–3 minutes (downloads the OpenRocket JAR and installs Python/Node packages). Subsequent starts are instant.

| Service  | URL                       |
|----------|---------------------------|
| Frontend | http://localhost:5175     |
| Backend  | http://localhost:8080     |
| API docs | http://localhost:8080/docs |

## Manual Setup (without Docker)

Use this if you want to run without Docker or do active development.

**Prerequisites**

- Python 3.11+
- Node 20+
- Java 17 JRE — install via your package manager or [Adoptium](https://adoptium.net/)
- OpenRocket JAR v23.09 — [download here](https://github.com/openrocket/openrocket/releases/download/release-23.09/OpenRocket-23.09.jar) and place in `backend/`

**Backend**

```bash
cd backend
python -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

**Frontend** (new terminal)

```bash
cd frontend
npm install
npm run dev
```

Open **http://localhost:5173**.

---

## How to Use

### 1. Export from OpenRocket

Save your rocket design as a `.ork` file (File → Save As).

### 2. Upload & configure

Drop the `.ork` file into the upload area. Set your launch site coordinates, elevation, rail length, inclination, and heading. Toggle between imperial and metric units at any time.

Click **Use my location** to auto-fill coordinates from your browser's geolocation.

### 3. Live weather (optional)

Enable **Use live weather (NOMADS GFS)** to pull real forecast data. GFS runs every 6 hours — pick the time closest to your launch window. Without it, a standard atmosphere (no wind) is used, so parachute drift will be zero.

### 4. Run Simulation

Click **Run Simulation**. RocketBridge runs OpenRocket and RocketPy simultaneously (15–30 s). Results stream in via SSE with a progress bar.

### 5. Review results

- **Comparison table** — side-by-side metrics with percent deltas (green ≤5%, yellow ≤15%, red >15%)
- **Configuration warnings** — yellow collapsible box listing any approximated parameters (collapsed by default; click to expand)
- **Rocket Profile** — cross-section diagram of your rocket
- **Fin Shape Comparison** — when freeform fins are approximated as trapezoidal, a diagram shows the original vs. approximated shape (in the left sidebar, collapsible)
- **Time-series charts** — altitude, velocity, Mach, stability margin, and thrust vs. time
- **3D trajectory** — animated flight path with event markers (launch, burnout, apogee, landing)
- **Rocket orientation** — animated attitude relative to the ENU frame
- **Map overlay** — satellite imagery with trajectory path, drift forecast dots, and optional aircraft layer
- **KML download** — open the trajectory in Google Earth Pro

### 6. Correct fallback values

When RocketBridge can't extract exact values from the `.ork` file (e.g., freeform fins → trapezoidal approximation, single-grain default for multi-grain motors), it shows a **Configuration Warnings** box with editable fields. Edit the values and click **Re-run with corrected fin values** to resimulate.

### 7. Rocket Details

Click **Rocket Details** in the header to see motor designation, dimensions, mass breakdown, fin count, parachute count, and weather source.

---

## Tools Page

Click the **Tools** tab in the header to access six specialized tools:

### Fin Flutter

Computes critical flutter velocity vs. altitude using Raymer's simplified formula. Edit fin geometry (root chord, tip chord, span, thickness) and select a material (Aluminum 6061, G10 Fiberglass, Carbon Fiber UD, Plywood, or custom). A Mach-vs-altitude chart shows the flutter threshold against the rocket's Mach profile. A safety factor verdict (green/yellow/red) indicates whether flutter margin is adequate.

**Requires:** Simulation result (for Mach profile data)

### Flight Card PDF

Generates a printable flight card for RSO check-in. Shows motor designation, apogee, max velocity, stability margin, off-rail velocity, burn time, launch coordinates, and a full comparison table. Downloads as a letter-sized PDF with any configuration warnings included.

**Requires:** Simulation result

### Airspace

Displays a Leaflet map with live air traffic (OpenSky Network, auto-refreshes every 2 minutes) and active NOTAMs (requires a free FAA API key). Aircraft markers show callsign, altitude, speed, and heading on click. Click **My location** to center on your current GPS position. Adjust the radius (0.5–3°) and altitude filter. The expected apogee is shown for reference.

**FAA NOTAM key:** Click "Add API key" in the NOTAM unavailable banner. Keys are saved in your browser's localStorage. Get a free key from [FAA NOTAM Search](https://notams.aim.faa.gov/notamSearch/SearchServlet).

**Requires:** Nothing (works without simulation)

### Parameter Sweep

Varies one launch parameter (inclination, rail length, heading, or elevation) across a user-defined range with 2–20 steps. Results show a dual-axis Plotly chart (apogee left axis, stability right axis) with a dashed vertical line at the current config value, plus a data table.

**Requires:** Simulation result + re-upload .ork file

### Motor Comparison

Compare up to 5 alternative motors against your design. Search the ThrustCurve.org database by designation, manufacturer, or impulse class. Results show a grouped bar chart of apogee per motor and a detailed comparison table. Failed motors show inline errors.

**Requires:** Simulation result + re-upload .ork file

### Monte Carlo

Dispersion analysis with N randomized simulations (10–500). Vary wind speed (σ m/s), mass (%), and drag coefficient (%). An orange-dot scatter map shows landing positions, and a statistics table reports mean, std, P5/P50/P95 for apogee, max velocity, and stability.

**Requires:** Simulation result + re-upload .ork file

---

## Features

- Side-by-side OpenRocket vs. RocketPy comparison with percent-delta highlighting
- Interactive time-series charts: altitude, velocity, Mach, stability margin, thrust
- Animated 3D trajectory plot (East/North/Altitude, metric or imperial)
- Animated rocket orientation (attitude relative to ENU frame)
- Satellite map overlay with altitude color gradient and event markers
- Aircraft overlay with live OpenSky data and NOTAM display
- KML export for Google Earth Pro (3D absolute altitude)
- Live NOMADS GFS weather with selectable forecast date/time
- Imperial/metric toggle throughout (including launch config inputs)
- Rocket details panel: motor designation, dimensions, mass breakdown
- Freeform fin comparison diagram (original vs. trapezoidal approximation)
- Editable fin override inputs with re-simulation
- Configuration warnings for approximated motor and fin parameters

---

## Common Issues & Troubleshooting

### "Simulation failed — Java not available"

RocketBridge needs Java 17+ to run OpenRocket. In Docker, this is handled automatically. For manual setup:

```bash
# Check your Java version
java -version
# Should show 17.x or higher. If not:
# macOS: brew install openjdk@17
# Ubuntu: sudo apt install openjdk-17-jre
```

Set `OR_JAR_PATH` environment variable if OpenRocket is installed elsewhere:
```bash
export OR_JAR_PATH=/path/to/OpenRocket-23.09.jar
```

### "Simulation failed — local variable 'math' referenced before assignment"

This was a bug fixed in the current version. Make sure you're on the latest commit (`git pull`).

### Map shows up blank or doesn't load

Leaflet maps need their container to be visible when initializing. If you switch tabs before the map renders, click the tab again — the map will initialize on visibility via IntersectionObserver.

### Aircraft data not showing

The OpenSky Network API has an anonymous rate limit of ~400 requests/day. If aircraft stop appearing, you've hit the limit. Wait 24 hours or use a registered account. The auto-refresh skips ticks when the tab is hidden to conserve quota.

### NOTAMs show "API key not configured"

NOTAM data requires a free FAA API key. In the Airspace tool, click "Add API key" in the banner and paste your key. It's saved in localStorage for reuse. Get a key from [FAA Data Portal](https://aa.data.faa.gov/data/register.jsf).

### "Results may be outdated" banner

This appears when you refresh the page and cached results are more than 30 minutes old. Click **Run Simulation** again for fresh results, or **Clear** to dismiss.

### Configuration Warnings box

When the `.ork` file contains data that RocketBridge can't extract exactly, warnings appear (collapsed by default). Common warnings:

- **Freeform fins approximated as trapezoidal** — a comparison diagram shows the shape difference, and you can edit fin dimensions and re-run
- **Grain geometry approximated** — single-grain default for multi-grain motors; grain density may be inaccurate
- **Motor dry inertia estimated** — computed from dimensions, not from .ork data
- **Nozzle/throat dimensions approximated** — derived from motor diameter formula
- **Parachute Cd default** — Cd=1.0 used when OpenRocket's computed Cd can't be extracted

### Port conflicts

Default ports are 5175 (frontend) and 8080 (backend). To change them, edit `docker-compose.yml`:

```yaml
ports:
  - "8081:8000"  # backend: host_port:container_port
```

And update the frontend `vite.config.ts` proxy target accordingly.

### Docker not starting

```bash
# Rebuild from scratch
docker compose down
docker compose up --build

# Check logs
docker compose logs backend --tail 50
docker compose logs frontend --tail 50
```

---

## Stack

| Layer    | Technology                              |
|----------|-----------------------------------------|
| Frontend | React 19 · TypeScript · Vite · Tailwind CSS · Plotly.js · Leaflet |
| Backend  | FastAPI · RocketPy · rocketserializer · orhelper (JPype) |
| Runtime  | Java 17 JRE · Python 3.11 · Node 20    |