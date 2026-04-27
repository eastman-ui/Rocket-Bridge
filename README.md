# RocketBridge

RocketBridge bridges OpenRocket and RocketPy. Upload a `.ork` file, configure your launch site, and RocketBridge runs both simulators in parallel — returning a side-by-side comparison of key flight metrics, interactive time-series charts, a 3D trajectory, satellite map overlay, rocket orientation animation, and a downloadable KML file for Google Earth.

## Quick Start (Docker — recommended)

Docker handles all dependencies automatically, including Java 17 and the OpenRocket JAR.

**Prerequisites:** [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Mac/Windows/Linux)

```bash
git clone <repo-url>
cd RocketBridge
docker compose up --build
```

Open **http://localhost:5175** — that's it.

> First build takes 2–3 minutes (downloads the OpenRocket JAR and installs Python/Node packages). Subsequent starts are instant.

| Service  | URL                       |
|----------|---------------------------|
| Frontend | http://localhost:5175     |
| Backend  | http://localhost:8080     |

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

## How to use

1. **Export** your rocket from OpenRocket as a `.ork` file (File → Save As)
2. **Upload** the file and configure your launch site (lat/lon, elevation, rail length, inclination, heading)
3. **Optionally** enable live weather (NOMADS GFS) and pick a forecast date/time
4. Click **Run Simulation** — results appear in 15–30 seconds
5. Review the comparison table, charts, 3D trajectory, map overlay, and orientation animation
6. Click **Download KML** on the map panel to open the trajectory in Google Earth Pro
7. Click **Rocket Details** in the header to verify the extracted rocket parameters

> The `?` icon in the header has a full walkthrough inside the app.

## Features

- Side-by-side OpenRocket vs RocketPy comparison with percent-delta highlighting
- Interactive time-series charts: altitude, velocity, Mach, stability margin, thrust
- Animated 3D trajectory plot (East/North/altitude, metric or imperial)
- Animated rocket orientation (attitude relative to ENU frame through full flight)
- Satellite map overlay with altitude color gradient and event markers
- KML export for Google Earth Pro (3D absolute altitude)
- Live NOMADS GFS weather with selectable forecast date/time
- Imperial/metric toggle throughout (including launch config inputs)
- Rocket details panel: motor designation, dimensions, mass breakdown

## Notes

- **Parachute drift** in the trajectory is only non-zero when live weather is enabled. Standard atmosphere has no wind model.
- **OpenRocket results** require Java 17. If Java is unavailable, RocketBridge falls back to stored simulation results from the `.ork` file.
- **GFS weather** fetches the nearest 00/06/12/18 UTC run to the selected date/time.

## Stack

| Layer    | Technology                              |
|----------|-----------------------------------------|
| Frontend | React 19 · TypeScript · Vite · Tailwind CSS · Plotly.js · Leaflet |
| Backend  | FastAPI · RocketPy · rocketserializer · orhelper (JPype) |
| Runtime  | Java 17 JRE · Python 3.11 · Node 20    |
