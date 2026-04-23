# RocketBridge

RocketBridge is a web application that bridges OpenRocket and RocketPy simulations. Upload a `.ork` file, and RocketBridge automatically converts it to a RocketPy model, runs both simulations in parallel, and presents a side-by-side comparison table of key flight metrics alongside an interactive 3D trajectory visualization — making it easy to validate your OpenRocket designs against the RocketPy physics engine.

## Prerequisites

- **Python 3.11+**
- **Node 20+**
- **Java 17 JRE** (required by orhelper/JPype to interface with OpenRocket)
- **OpenRocket JAR v23.09** — download from [openrocket.info](https://openrocket.info/) and place it in `backend/` (or configure the path in your environment)

## Setup

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

### Frontend

```bash
cd frontend
npm install
```

## Running

### Backend

```bash
cd backend
source .venv/bin/activate
uvicorn main:app --reload --port 8000
```

The API will be available at `http://localhost:8000`. Health check: `GET /health`.

### Frontend

```bash
cd frontend
npm run dev
```

The app will be available at `http://localhost:5173`. API calls are proxied to `http://localhost:8000` automatically.

## Docker (alternative)

Run both services with a single command from the project root:

```bash
docker compose up --build
```

- Backend: `http://localhost:8000`
- Frontend: `http://localhost:5173`

> Note: The OpenRocket JAR must be present in `backend/` before building the Docker image, or mounted via volume.
