# Live GPS Tracking Tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a standalone Live Tracking tool to the Tools tab that reads LoRa GPS telemetry from a USB ground station via the Web Serial API and plots the rocket's real-time flight path on a Leaflet map.

**Architecture:** Frontend-only — no backend changes. The Web Serial API runs in the browser on the host machine. GPS points accumulate in React state; the Leaflet map updates imperatively via refs (same pattern as `TrajectoryMap.tsx`). Helpers (`enuToLatLon`, `altColor`) are copied into the new file for self-containment.

**Tech Stack:** React, TypeScript, Leaflet (already installed), Web Serial API (browser native). No new npm dependencies.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `frontend/src/tools/LiveTrackingTool.tsx` | **Create** | Full tool: types, parser, map, serial loop, UI |
| `frontend/src/pages/ToolsPage.tsx` | **Modify** | Register tool, import component, mount panel |

---

## Task 1: Create LiveTrackingTool.tsx — types, helpers, and parser

**Files:**
- Create: `frontend/src/tools/LiveTrackingTool.tsx`

- [ ] **Step 1: Create the file with the GpsPoint interface, copied helpers, and parser**

```tsx
import { useState, useEffect, useRef, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// ── Types ──────────────────────────────────────────────────────────────────

interface GpsPoint {
  lat: number;
  lon: number;
  alt_m: number;
  speed_ms?: number;
  heading_deg?: number;
  rssi?: number;
  t: number; // elapsed seconds from first fix
}

type Status = 'disconnected' | 'connected' | 'live';

interface Props {
  unitSystem: 'imperial' | 'metric';
}

// ── Helpers (self-contained copies from TrajectoryMap) ─────────────────────

const R_EARTH = 6378137;

function enuToLatLon(x: number, y: number, launchLat: number, launchLon: number): [number, number] {
  const lat = launchLat + (y / R_EARTH) * (180 / Math.PI);
  const lon = launchLon + (x / (R_EARTH * Math.cos(launchLat * Math.PI / 180))) * (180 / Math.PI);
  return [lat, lon];
}

function altColor(frac: number): string {
  const stops: [number, [number, number, number]][] = [
    [0.00, [59, 130, 246]],
    [0.33, [34, 211, 238]],
    [0.60, [74, 222, 128]],
    [0.80, [250, 204, 21]],
    [1.00, [239, 68, 68]],
  ];
  let lo = stops[0], hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (frac >= stops[i][0] && frac <= stops[i + 1][0]) { lo = stops[i]; hi = stops[i + 1]; break; }
  }
  const t = hi[0] === lo[0] ? 0 : (frac - lo[0]) / (hi[0] - lo[0]);
  return `rgb(${Math.round(lo[1][0]+t*(hi[1][0]-lo[1][0]))},${Math.round(lo[1][1]+t*(hi[1][1]-lo[1][1]))},${Math.round(lo[1][2]+t*(hi[1][2]-lo[1][2]))})`;
}

// ── Parser ─────────────────────────────────────────────────────────────────

function parseGpsLine(line: string, t0: number): GpsPoint | null {
  line = line.trim();
  if (!line) return null;

  if (line.startsWith('$GPGGA')) {
    const p = line.split(',');
    if (p.length < 10) return null;
    if (!parseInt(p[6], 10)) return null; // fixQuality 0 = no fix
    const rawLat = parseFloat(p[2]);
    const rawLon = parseFloat(p[4]);
    const altM = parseFloat(p[9]);
    if (!Number.isFinite(rawLat) || !Number.isFinite(rawLon) || !Number.isFinite(altM)) return null;
    const latDeg = Math.floor(rawLat / 100) + (rawLat % 100) / 60;
    const lonDeg = Math.floor(rawLon / 100) + (rawLon % 100) / 60;
    return {
      lat: p[3] === 'S' ? -latDeg : latDeg,
      lon: p[5] === 'W' ? -lonDeg : lonDeg,
      alt_m: altM,
      t: Date.now() / 1000 - t0,
    };
  }

  if (line.startsWith('$')) return null; // other NMEA sentence — skip

  const p = line.split(',');
  if (p.length < 3) return null;
  const lat = parseFloat(p[0]);
  const lon = parseFloat(p[1]);
  const alt_m = parseFloat(p[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(alt_m)) return null;
  const speed_ms = parseFloat(p[3]);
  const heading_deg = parseFloat(p[4]);
  const rssi = parseFloat(p[5]);
  return {
    lat, lon, alt_m,
    speed_ms: Number.isFinite(speed_ms) ? speed_ms : undefined,
    heading_deg: Number.isFinite(heading_deg) ? heading_deg : undefined,
    rssi: Number.isFinite(rssi) ? rssi : undefined,
    t: Date.now() / 1000 - t0,
  };
}

// ── Landing prediction ──────────────────────────────────────────────────────

function predictLanding(points: GpsPoint[]): [number, number] | null {
  const n = points.length;
  if (n < 4) return null;
  const cur = points[n - 1];
  const old = points[n - 4];
  if (cur.alt_m >= old.alt_m) return null; // not descending
  if (cur.speed_ms == null || cur.heading_deg == null) return null;
  const dt = cur.t - old.t;
  if (dt <= 0) return null;
  const descentRate = (cur.alt_m - old.alt_m) / dt; // negative m/s
  const timeToGround = cur.alt_m / Math.abs(descentRate);
  const headingRad = cur.heading_deg * Math.PI / 180;
  const dx = cur.speed_ms * Math.sin(headingRad) * timeToGround;
  const dy = cur.speed_ms * Math.cos(headingRad) * timeToGround;
  return enuToLatLon(dx, dy, cur.lat, cur.lon);
}

// ── Marker icon ─────────────────────────────────────────────────────────────

function rocketIcon(heading?: number): L.DivIcon {
  return L.divIcon({
    className: '',
    iconSize: [20, 20],
    iconAnchor: [10, 10],
    html: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
             style="transform:rotate(${heading ?? 0}deg)">
             <polygon points="12,2 16,20 12,16 8,20" fill="#f59e0b" stroke="#92400e" stroke-width="1"/>
           </svg>`,
  });
}

// ── Constants ───────────────────────────────────────────────────────────────

const BAUD_RATES = [4800, 9600, 38400, 57600, 115200];
const HAS_SERIAL = typeof navigator !== 'undefined' && 'serial' in navigator;
```

- [ ] **Step 2: Verify the file compiles**

Open a terminal and run:
```bash
cd frontend
npx tsc --noEmit
```
Expected: no errors related to `LiveTrackingTool.tsx` (the file has no default export yet — that's fine, add it next task).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/tools/LiveTrackingTool.tsx
git commit -m "feat: add LiveTrackingTool types, helpers, and parser"
```

---

## Task 2: Add Leaflet map and imperative layer management

**Files:**
- Modify: `frontend/src/tools/LiveTrackingTool.tsx`

- [ ] **Step 1: Add the component shell with map initialization**

Append after the constants block in `LiveTrackingTool.tsx`:

```tsx
export function LiveTrackingTool({ unitSystem }: Props) {
  const imp = unitSystem === 'imperial';

  // ── State ─────────────────────────────────────────────────────────────────
  const [status, setStatus] = useState<Status>('disconnected');
  const [baudRate, setBaudRate] = useState(115200);
  const [points, setPoints] = useState<GpsPoint[]>([]);
  const [launchLat, setLaunchLat] = useState('');
  const [launchLon, setLaunchLon] = useState('');
  const [waiverFt, setWaiverFt] = useState('');
  const [configOpen, setConfigOpen] = useState(true);
  const [lastRssi, setLastRssi] = useState<number | null>(null);

  // ── Refs ──────────────────────────────────────────────────────────────────
  const mapDivRef = useRef<HTMLDivElement>(null);
  const leafletMap = useRef<L.Map | null>(null);
  const trackSegs = useRef<L.Polyline[]>([]);
  const posMarker = useRef<L.Marker | null>(null);
  const launchMarker = useRef<L.Marker | null>(null);
  const waiverCircle = useRef<L.Circle | null>(null);
  const landingMarker = useRef<L.Marker | null>(null);
  const portRef = useRef<any>(null);
  const readerRef = useRef<any>(null);
  const t0Ref = useRef<number>(0);

  // ── Map init ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapDivRef.current || leafletMap.current) return;
    const map = L.map(mapDivRef.current, { center: [39.0, -104.0], zoom: 13, zoomAnimation: false });
    leafletMap.current = map;
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { attribution: '© Esri', maxZoom: 19 }
    ).addTo(map);
    L.tileLayer(
      'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, opacity: 0.7 }
    ).addTo(map);
    return () => { map.remove(); leafletMap.current = null; };
  }, []);

  // ── Waiver circle (redraws when config changes) ───────────────────────────
  useEffect(() => {
    const map = leafletMap.current;
    if (!map) return;
    if (waiverCircle.current) { map.removeLayer(waiverCircle.current); waiverCircle.current = null; }
    const lat = parseFloat(launchLat);
    const lon = parseFloat(launchLon);
    const radiusM = parseFloat(waiverFt) * 0.3048;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !(radiusM > 0)) return;
    waiverCircle.current = L.circle([lat, lon], {
      radius: radiusM,
      color: '#ef4444', weight: 2, opacity: 0.8, dashArray: '8 6',
      fillColor: '#ef4444', fillOpacity: 0.06,
    }).addTo(map);
  }, [launchLat, launchLon, waiverFt]);

  // ── Launch marker (redraws when lat/lon change) ───────────────────────────
  useEffect(() => {
    const map = leafletMap.current;
    if (!map) return;
    if (launchMarker.current) { map.removeLayer(launchMarker.current); launchMarker.current = null; }
    const lat = parseFloat(launchLat);
    const lon = parseFloat(launchLon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    launchMarker.current = L.marker([lat, lon], {
      icon: L.divIcon({
        html: '<div style="width:12px;height:12px;background:#34d399;border-radius:50%;border:2px solid #fff;box-shadow:0 0 4px rgba(0,0,0,.5)"></div>',
        className: '', iconSize: [12, 12], iconAnchor: [6, 6],
      }),
    }).bindPopup('<b>Launch Site</b>').addTo(map);
    map.panTo([lat, lon]);
  }, [launchLat, launchLon]);
```

- [ ] **Step 2: Add the imperative map update callback**

Continue appending to the component (still inside `LiveTrackingTool`):

```tsx
  // ── Imperative track update ────────────────────────────────────────────────
  const addPointToMap = useCallback((point: GpsPoint, allPoints: GpsPoint[]) => {
    const map = leafletMap.current;
    if (!map) return;
    const n = allPoints.length;
    const alts = allPoints.map(p => p.alt_m);
    const minAlt = Math.min(...alts);
    const maxAlt = Math.max(...alts);
    const altRange = maxAlt - minAlt || 1;

    if (n >= 2) {
      const prev = allPoints[n - 2];
      const frac = (point.alt_m - minAlt) / altRange;
      trackSegs.current.push(
        L.polyline([[prev.lat, prev.lon], [point.lat, point.lon]], {
          color: altColor(frac), weight: 3, opacity: 0.9,
        }).addTo(map)
      );
    }

    if (posMarker.current) {
      posMarker.current.setLatLng([point.lat, point.lon]);
      posMarker.current.setIcon(rocketIcon(point.heading_deg));
    } else {
      posMarker.current = L.marker([point.lat, point.lon], { icon: rocketIcon(point.heading_deg) })
        .bindPopup('<b>Rocket</b>').addTo(map);
    }

    map.panTo([point.lat, point.lon], { animate: true, duration: 0.5 });

    if (landingMarker.current) { map.removeLayer(landingMarker.current); landingMarker.current = null; }
    const pred = predictLanding(allPoints);
    if (pred) {
      landingMarker.current = L.marker(pred, {
        icon: L.divIcon({
          html: '<div style="width:12px;height:12px;background:#f59e0b;border-radius:50%;border:2px solid #fff;box-shadow:0 0 6px rgba(245,158,11,.8)"></div>',
          className: '', iconSize: [12, 12], iconAnchor: [6, 6],
        }),
      }).bindPopup('<b>Predicted Landing</b>').addTo(map);
    }
  }, []);
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/tools/LiveTrackingTool.tsx
git commit -m "feat: add LiveTrackingTool Leaflet map and layer management"
```

---

## Task 3: Add serial connection logic

**Files:**
- Modify: `frontend/src/tools/LiveTrackingTool.tsx`

- [ ] **Step 1: Add connect, disconnect, clear, and export functions**

Continue appending to the component:

```tsx
  // ── Serial connection ──────────────────────────────────────────────────────
  async function connect() {
    if (!HAS_SERIAL) return;
    try {
      const port = await (navigator as any).serial.requestPort();
      await port.open({ baudRate });
      portRef.current = port;
      t0Ref.current = Date.now() / 1000;
      setStatus('connected');
      const reader = port.readable.getReader();
      readerRef.current = reader;
      const decoder = new TextDecoder();
      let buf = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            const pt = parseGpsLine(line, t0Ref.current);
            if (!pt) continue;
            if (pt.rssi != null) setLastRssi(pt.rssi);
            setStatus('live');
            setPoints(prev => {
              const next = [...prev, pt];
              if (prev.length === 0) {
                setLaunchLat(String(pt.lat));
                setLaunchLon(String(pt.lon));
              }
              addPointToMap(pt, next);
              return next;
            });
          }
        }
      } catch { /* serial read error or device unplugged */ }
      finally { reader.releaseLock(); }
    } catch { /* user denied port access */ }
    setStatus('disconnected');
    portRef.current = null;
    readerRef.current = null;
  }

  async function disconnect() {
    try { await readerRef.current?.cancel(); } catch { /* ignore */ }
    try { await portRef.current?.close(); } catch { /* ignore */ }
    setStatus('disconnected');
    portRef.current = null;
    readerRef.current = null;
  }

  function clearTrack() {
    const map = leafletMap.current;
    if (map) {
      trackSegs.current.forEach(s => map.removeLayer(s));
      if (posMarker.current) { map.removeLayer(posMarker.current); posMarker.current = null; }
      if (landingMarker.current) { map.removeLayer(landingMarker.current); landingMarker.current = null; }
    }
    trackSegs.current = [];
    setPoints([]);
    setLastRssi(null);
  }

  function exportCsv() {
    const rows = ['time_s,lat,lon,alt_m,speed_ms,heading_deg,rssi'];
    for (const p of points) {
      rows.push([
        p.t.toFixed(2), p.lat, p.lon, p.alt_m,
        p.speed_ms ?? '', p.heading_deg ?? '', p.rssi ?? '',
      ].join(','));
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gps_track_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/tools/LiveTrackingTool.tsx
git commit -m "feat: add LiveTrackingTool serial read loop and track controls"
```

---

## Task 4: Add full JSX UI and close the component

**Files:**
- Modify: `frontend/src/tools/LiveTrackingTool.tsx`

- [ ] **Step 1: Add derived display values and the full JSX return**

Continue appending to the component (closes the function):

```tsx
  // ── Derived display values ─────────────────────────────────────────────────
  const connected = status !== 'disconnected';
  const cur = points[points.length - 1];
  const maxAltVal = points.reduce((m, p) => (p.alt_m > m ? p.alt_m : m), -Infinity);
  const altScale = imp ? 3.28084 : 1;
  const altUnit = imp ? 'ft' : 'm';
  const speedScale = imp ? 2.23694 : 1; // m/s → mph (imperial) or m/s (metric)
  const speedUnit = imp ? 'mph' : 'm/s';
  const statusColor = status === 'live' ? 'text-green-400' : status === 'connected' ? 'text-yellow-400' : 'text-gray-500';
  const statusLabel = status === 'live' ? 'Live' : status === 'connected' ? 'Connected — no fix' : 'Disconnected';

  const stats = [
    { label: 'Alt', value: cur ? `${Math.round(cur.alt_m * altScale).toLocaleString()} ${altUnit}` : '—' },
    { label: 'Max Alt', value: Number.isFinite(maxAltVal) ? `${Math.round(maxAltVal * altScale).toLocaleString()} ${altUnit}` : '—' },
    { label: 'Speed', value: cur?.speed_ms != null ? `${(cur.speed_ms * speedScale).toFixed(1)} ${speedUnit}` : '—' },
    { label: 'Heading', value: cur?.heading_deg != null ? `${Math.round(cur.heading_deg)}°` : '—' },
    { label: 'Fixes', value: String(points.length) },
    { label: 'Elapsed', value: cur ? `${cur.t.toFixed(0)} s` : '0 s' },
  ];

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-gray-200 uppercase tracking-wide">Live GPS Tracking</h3>

      {!HAS_SERIAL && (
        <p className="text-xs text-amber-400 bg-amber-950/30 border border-amber-800/40 rounded-lg px-3 py-2">
          Live tracking requires Chrome or Edge — Web Serial API not available in this browser.
        </p>
      )}

      {/* Connection bar */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={connected ? disconnect : connect}
          disabled={!HAS_SERIAL}
          className={`px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors shrink-0 ${
            connected
              ? 'bg-red-800 hover:bg-red-700 text-white'
              : 'bg-blue-800 hover:bg-blue-700 text-white disabled:opacity-40 disabled:cursor-not-allowed'
          }`}
        >
          {connected ? 'Disconnect' : 'Connect'}
        </button>
        <select
          value={baudRate}
          onChange={e => setBaudRate(Number(e.target.value))}
          disabled={connected}
          className="text-xs bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-gray-300 focus:outline-none disabled:opacity-50"
        >
          {BAUD_RATES.map(b => <option key={b} value={b}>{b} baud</option>)}
        </select>
        <span className={`text-xs font-medium ${statusColor}`}>{statusLabel}</span>
        {status === 'live' && <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />}
        {lastRssi !== null && (
          <span className="text-xs text-gray-500 font-mono">RSSI: {lastRssi} dBm</span>
        )}
      </div>

      {/* Config panel */}
      <div className="bg-gray-950 border border-gray-800 rounded-xl overflow-hidden">
        <button
          onClick={() => setConfigOpen(v => !v)}
          className="w-full flex items-center justify-between px-4 py-2.5 text-xs font-semibold text-gray-400 hover:text-gray-200 transition-colors"
        >
          <span>Launch Config</span>
          <span>{configOpen ? '▲' : '▼'}</span>
        </button>
        {configOpen && (
          <div className="px-4 pb-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
            {[
              { label: 'Launch Lat', val: launchLat, set: setLaunchLat, ph: '39.0000' },
              { label: 'Launch Lon', val: launchLon, set: setLaunchLon, ph: '-104.0000' },
              { label: 'Waiver Radius (ft)', val: waiverFt, set: setWaiverFt, ph: '5000' },
            ].map(({ label, val, set, ph }) => (
              <div key={label}>
                <label className="block text-[10px] text-gray-500 uppercase mb-1">{label}</label>
                <input
                  type="number" step="any" value={val} placeholder={ph}
                  onChange={e => set(e.target.value)}
                  className="w-full bg-gray-900 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Map */}
      <div ref={mapDivRef} className="rounded-lg overflow-hidden" style={{ height: 480 }} />
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-600">Low</span>
        <div className="flex-1 h-2 rounded" style={{
          background: 'linear-gradient(to right, rgb(59,130,246), rgb(34,211,238), rgb(74,222,128), rgb(250,204,21), rgb(239,68,68))'
        }} />
        <span className="text-xs text-gray-600">High alt</span>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        {stats.map(({ label, value }) => (
          <div key={label} className="bg-gray-950 border border-gray-800 rounded-lg p-2 text-center">
            <p className="text-[10px] text-gray-500 uppercase mb-0.5">{label}</p>
            <p className="text-xs font-mono font-semibold text-gray-200 truncate">{value}</p>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex gap-3">
        <button
          onClick={clearTrack}
          disabled={points.length === 0}
          className="text-xs px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-gray-300 hover:text-white hover:border-gray-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Clear Track
        </button>
        <button
          onClick={exportCsv}
          disabled={points.length === 0}
          className="text-xs px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-gray-300 hover:text-white hover:border-gray-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Export CSV
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles with no errors**

```bash
cd frontend && npx tsc --noEmit
```
Expected: exit 0, no errors.

- [ ] **Step 3: Verify the tool renders in the browser**

The tool isn't wired into the app yet (Task 5 does that). For now, temporarily import and render it in `App.tsx` just to confirm it mounts:

```tsx
// Temporary — add to App.tsx return:
import { LiveTrackingTool } from './tools/LiveTrackingTool';
// ...
<LiveTrackingTool unitSystem="imperial" />
```

Open the app in Chrome. Expected:
- "Live GPS Tracking" heading visible
- "Live tracking requires Chrome or Edge" warning NOT shown (Chrome supports Web Serial)
- Connect button visible and enabled
- Baud rate selector defaults to 115200
- Status shows "Disconnected"
- Launch Config panel is open with three inputs
- Leaflet map renders (satellite tiles load)
- Stats grid shows "—" for all values
- Clear Track and Export CSV buttons are disabled (grey)

Revert the temporary `App.tsx` change after verifying.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/tools/LiveTrackingTool.tsx
git commit -m "feat: complete LiveTrackingTool UI with serial loop and map"
```

---

## Task 5: Wire LiveTrackingTool into ToolsPage

**Files:**
- Modify: `frontend/src/pages/ToolsPage.tsx`

- [ ] **Step 1: Read the current ToolsPage to get exact line numbers**

Open `frontend/src/pages/ToolsPage.tsx`. The key sections are:
- Import block (lines 1–14)
- `ToolId` type (line 26)
- `TOOLS` array (lines 36–138)
- Panel section (lines 201–244)

- [ ] **Step 2: Add import for LiveTrackingTool**

In `ToolsPage.tsx`, add after the last import line (after `CGCPAnimationTool` import):

```tsx
import { LiveTrackingTool } from '../tools/LiveTrackingTool';
```

- [ ] **Step 3: Add 'livetrack' to the ToolId union**

Change:
```tsx
type ToolId = 'flutter' | 'flightcard' | 'airspace' | 'sweep' | 'motors' | 'montecarlo' | 'altimeter' | 'ejection' | 'cgcp';
```
To:
```tsx
type ToolId = 'flutter' | 'flightcard' | 'airspace' | 'sweep' | 'motors' | 'montecarlo' | 'altimeter' | 'ejection' | 'cgcp' | 'livetrack';
```

- [ ] **Step 4: Add the tool definition to the TOOLS array**

Add this entry at the end of the `TOOLS` array (before the closing `]`):

```tsx
  {
    id: 'livetrack',
    label: 'Live Tracking',
    description: 'Real-time GPS flight track via USB LoRa ground station — Web Serial API',
    needsResult: false,
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
      </svg>
    ),
  },
```

- [ ] **Step 5: Mount the LiveTrackingTool panel**

Inside the "Active tool panel" section (after the `cgcp` panel block), add:

```tsx
        <div style={activeTool === 'livetrack' ? {} : { display: 'none' }}>
          <LiveTrackingTool unitSystem={unitSystem} />
        </div>
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit
```
Expected: exit 0.

- [ ] **Step 7: Verify in browser**

Open the app in Chrome → navigate to the Tools tab. Expected:
- "Live Tracking" tile appears in the tool grid
- It is enabled (not greyed out) — `needsResult: false`
- Clicking it expands the panel and shows the Live GPS Tracking tool
- Clicking another tool collapses it; clicking Live Tracking again re-opens it
- The Leaflet map is visible and loads satellite tiles
- Entering a lat/lon in Launch Config and a waiver radius draws the red dashed circle on the map
- Connect button triggers the browser's port picker dialog (Chrome only)

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/ToolsPage.tsx
git commit -m "feat: wire LiveTrackingTool into ToolsPage"
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ Wire format: CSV + NMEA $GPGGA — `parseGpsLine` handles both
- ✅ Connection bar: Connect/Disconnect, baud select, status badge, RSSI display
- ✅ Config panel: launch lat/lon (auto-populated on first fix), waiver radius in ft
- ✅ Leaflet map: ESRI satellite + labels tile stack
- ✅ GPS track: altitude-colored polyline segments
- ✅ Current position: rocket SVG icon rotated to heading
- ✅ Launch point: green circle marker
- ✅ Waiver circle: red dashed `L.circle`
- ✅ Predicted landing: amber dot during descent, uses `predictLanding()`
- ✅ Stats row: Alt, Max Alt, Speed, Heading, Fixes, Elapsed
- ✅ Clear Track: removes all map layers, resets `points[]`
- ✅ Export CSV: downloads `gps_track_<timestamp>.csv`
- ✅ Web Serial not supported: amber warning banner
- ✅ User denies port: caught silently, status resets to Disconnected
- ✅ Serial error / unplug: caught in finally block, status resets
- ✅ Unparseable line: returns null, skipped silently
- ✅ $GPGGA fixQuality 0: returns null, status stays "Connected — no fix"
- ✅ No backend changes, no new npm deps

**Type consistency:**
- `GpsPoint` defined in Task 1, used in Tasks 2, 3, 4 — consistent
- `Status` type: `'disconnected' | 'connected' | 'live'` — consistent throughout
- `addPointToMap(point: GpsPoint, allPoints: GpsPoint[])` — matches call site in Task 3
- `predictLanding(points: GpsPoint[]): [number, number] | null` — matches usage in Task 2
