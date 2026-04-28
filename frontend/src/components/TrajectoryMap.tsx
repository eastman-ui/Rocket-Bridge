import { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { HourlyLanding, Trajectory3D } from '../types';
import type { WeatherData } from './WeatherPanel';

interface Aircraft {
  icao: string;
  callsign: string;
  lat: number;
  lon: number;
  alt_m: number;
  velocity_ms: number;
  heading: number;
  on_ground: boolean;
}

interface Props {
  trajectory: Trajectory3D;
  launchLat: number;
  launchLon: number;
  launchElevationM: number;
  apogeeTimeS: number;
  burnOutTimeS: number;
  kmlData?: string;
  weatherData?: WeatherData;
  weatherIsImperial?: boolean;
  launchDateTime?: string;
  hourlyLandings?: HourlyLanding[];
}

const DRIFT_P_LEVELS = [1000, 925, 850, 700, 500, 400, 300, 250, 200, 150, 100, 70, 50, 30, 20, 10] as const;

function pToAltM(hPa: number): number {
  const T0 = 288.15, L = 0.0065, P0 = 1013.25, g = 9.80665, R = 287.05;
  return Math.max(0, (T0 / L) * (1 - Math.pow(hPa / P0, (R * L) / g)));
}

// Compute predicted landing [lat, lon] for a given forecast hour index
function predictLanding(
  trajectory: Trajectory3D,
  apogeeTimeS: number,
  launchLat: number,
  launchLon: number,
  siteElevM: number,
  hourly: WeatherData['hourly'],
  hourIdx: number,
  speedToMs: number,
): [number, number] {
  const { t, x, y, z } = trajectory;
  const apogeeI = nearestIdx(t, apogeeTimeS);
  let dx = 0, dy = 0;

  for (let i = apogeeI; i < t.length - 1; i++) {
    const dt = t[i + 1] - t[i];
    const altAgl = Math.max(0, z[i] - z[0]);
    const altAsl = altAgl + siteElevM;

    let ws = (hourly.windspeed_10m as number[])[hourIdx] ?? 0;
    let wd = (hourly.winddirection_10m as number[])[hourIdx] ?? 0;
    let bestDiff = Infinity;

    for (const p of DRIFT_P_LEVELS) {
      const gph = (hourly[`geopotential_height_${p}hPa`] as number[])?.[hourIdx];
      const levelAlt = gph != null ? gph : pToAltM(p);
      const diff = Math.abs(levelAlt - altAsl);
      if (diff < bestDiff) {
        const pWs = (hourly[`windspeed_${p}hPa`] as number[])?.[hourIdx];
        const pWd = (hourly[`winddirection_${p}hPa`] as number[])?.[hourIdx];
        if (pWs != null && pWd != null) {
          bestDiff = diff;
          ws = pWs;
          wd = pWd;
        }
      }
    }

    const wsMs = ws * speedToMs;
    const wdRad = wd * Math.PI / 180;
    dx += -wsMs * Math.sin(wdRad) * dt;
    dy += -wsMs * Math.cos(wdRad) * dt;
  }

  return enuToLatLon(x[apogeeI] + dx, y[apogeeI] + dy, launchLat, launchLon);
}

// 8 visually distinct colors for hourly predictions
const DRIFT_COLORS = [
  '#38bdf8', '#818cf8', '#a78bfa', '#f472b6',
  '#fb923c', '#facc15', '#4ade80', '#34d399',
];

const R_EARTH = 6378137;

function enuToLatLon(
  x: number, y: number,
  launchLat: number, launchLon: number,
): [number, number] {
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
    if (frac >= stops[i][0] && frac <= stops[i + 1][0]) {
      lo = stops[i]; hi = stops[i + 1]; break;
    }
  }
  const t = hi[0] === lo[0] ? 0 : (frac - lo[0]) / (hi[0] - lo[0]);
  const r = Math.round(lo[1][0] + t * (hi[1][0] - lo[1][0]));
  const g = Math.round(lo[1][1] + t * (hi[1][1] - lo[1][1]));
  const b = Math.round(lo[1][2] + t * (hi[1][2] - lo[1][2]));
  return `rgb(${r},${g},${b})`;
}

function nearestIdx(times: number[], target: number): number {
  let best = 0, bestDiff = Infinity;
  for (let i = 0; i < times.length; i++) {
    const d = Math.abs(times[i] - target);
    if (d < bestDiff) { bestDiff = d; best = i; }
  }
  return best;
}

function downloadKml(kmlData: string) {
  const blob = new Blob([kmlData], { type: 'application/vnd.google-earth.kml+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'trajectory.kml';
  a.click();
  URL.revokeObjectURL(url);
}

function aircraftIcon(heading: number): L.DivIcon {
  return L.divIcon({
    className: '',
    iconSize: [20, 20],
    iconAnchor: [10, 10],
    html: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
             style="transform:rotate(${heading}deg)">
             <polygon points="12,2 16,20 12,16 8,20" fill="#f59e0b" stroke="#92400e" stroke-width="1"/>
           </svg>`,
  });
}

const M_FT = 3.28084;
const AC_REFRESH_MS = 120_000;

export function TrajectoryMap({
  trajectory, launchLat, launchLon, launchElevationM,
  apogeeTimeS, burnOutTimeS, kmlData,
  weatherData, weatherIsImperial, launchDateTime,
  hourlyLandings,
}: Props) {
  const mapRef = useRef<HTMLDivElement>(null);
  const leafletMap = useRef<L.Map | null>(null);
  const [showDrift, setShowDrift] = useState(true);
  const [showAircraft, setShowAircraft] = useState(false);
  const [aircraft, setAircraft] = useState<Aircraft[]>([]);

  const fetchAircraft = useCallback(() => {
    const d = 0.5;
    const url = `/api/airspace/aircraft?lamin=${launchLat - d}&lomin=${launchLon - d}&lamax=${launchLat + d}&lomax=${launchLon + d}`;
    fetch(url)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(j => {
        const ac: Aircraft[] = (j.states ?? [])
          .filter((s: any) => s[5] != null && s[6] != null)
          .map((s: any) => ({
            icao: s[0] as string,
            callsign: (s[1] as string)?.trim() || s[0],
            lon: s[5] as number,
            lat: s[6] as number,
            alt_m: (s[7] ?? s[13] ?? 0) as number,
            velocity_ms: (s[9] ?? 0) as number,
            heading: (s[10] ?? 0) as number,
            on_ground: s[8] as boolean,
          }))
          .filter((a: Aircraft) => !a.on_ground);
        setAircraft(ac);
      })
      .catch(() => setAircraft([]));
  }, [launchLat, launchLon]);

  useEffect(() => {
    if (!showAircraft) { setAircraft([]); return; }
    fetchAircraft();
    const id = setInterval(fetchAircraft, AC_REFRESH_MS);
    return () => clearInterval(id);
  }, [showAircraft, fetchAircraft]);

  useEffect(() => {
    if (!mapRef.current || trajectory.t.length === 0) return;

    // Destroy previous instance
    if (leafletMap.current) {
      leafletMap.current.remove();
      leafletMap.current = null;
    }

    const { t, x, y, z } = trajectory;
    const N = t.length;

    // Convert all points
    const latLons: [number, number][] = x.map((xi, i) =>
      enuToLatLon(xi, y[i], launchLat, launchLon)
    );

    const maxZ = Math.max(...z);
    const minZ = Math.min(...z);
    const zRange = maxZ - minZ || 1;

    // Center map between launch and apogee
    const apogeeI = nearestIdx(t, apogeeTimeS);
    const center: [number, number] = [
      (launchLat + latLons[apogeeI][0]) / 2,
      (launchLon + latLons[apogeeI][1]) / 2,
    ];

    const map = L.map(mapRef.current, {
      center,
      zoom: 13,
      zoomControl: true,
      zoomAnimation: false,
    });
    leafletMap.current = map;

    // Satellite / hybrid tiles via ESRI (no API key needed)
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        attribution: 'Tiles &copy; Esri &mdash; Source: Esri, DigitalGlobe, GeoEye, Earthstar Geographics, CNES/Airbus DS, USDA, USGS, AeroGRID, IGN',
        maxZoom: 19,
      }
    ).addTo(map);

    // Labels overlay on top of satellite
    L.tileLayer(
      'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, opacity: 0.7 }
    ).addTo(map);

    // Draw trajectory as colored segments (altitude gradient)
    const segSize = Math.max(1, Math.floor(N / 300));
    for (let i = 0; i < N - segSize; i += segSize) {
      const frac = (z[i] - minZ) / zRange;
      const color = altColor(frac);
      const pts: [number, number][] = [];
      for (let j = i; j <= Math.min(i + segSize, N - 1); j++) {
        pts.push(latLons[j]);
      }
      L.polyline(pts, {
        color,
        weight: 3,
        opacity: 0.85,
        smoothFactor: 1,
      }).addTo(map);
    }

    const iconHtml = (color: string, size = 10) =>
      `<div style="width:${size}px;height:${size}px;background:${color};border-radius:50%;border:2px solid #fff;box-shadow:0 0 4px rgba(0,0,0,.5)"></div>`;

    const makeIcon = (color: string, size = 10) => L.divIcon({
      html: iconHtml(color, size),
      className: '',
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });

    const burnoutI = nearestIdx(t, burnOutTimeS);
    const landingI = N - 1;

    const altLabel = (i: number) =>
      `${Math.round(z[i]).toLocaleString()} m ASL (${Math.round(z[i] - z[0]).toLocaleString()} m AGL)`;

    // Launch
    L.marker([launchLat, launchLon], { icon: makeIcon('#34d399', 12) })
      .bindPopup(`<b>Launch</b><br>t = 0 s<br>Alt: ${altLabel(0)}<br>Lat: ${launchLat.toFixed(5)}, Lon: ${launchLon.toFixed(5)}`)
      .addTo(map);

    // Burnout
    L.marker(latLons[burnoutI], { icon: makeIcon('#fb923c', 10) })
      .bindPopup(`<b>Motor Burnout</b><br>t = ${t[burnoutI].toFixed(1)} s<br>Alt: ${altLabel(burnoutI)}`)
      .addTo(map);

    // Apogee
    L.marker(latLons[apogeeI], { icon: makeIcon('#60a5fa', 14) })
      .bindPopup(`<b>Apogee</b><br>t = ${t[apogeeI].toFixed(1)} s<br>Alt: ${altLabel(apogeeI)}`)
      .addTo(map);

    // Landing
    L.marker(latLons[landingI], { icon: makeIcon('#94a3b8', 10) })
      .bindPopup(`<b>Landing</b><br>t = ${t[landingI].toFixed(1)} s<br>Alt: ${altLabel(landingI)}<br>Lat: ${latLons[landingI][0].toFixed(5)}, Lon: ${latLons[landingI][1].toFixed(5)}`)
      .addTo(map);

    // ── Drift predictions ──────────────────────────────────────────────────────
    const driftLatLons: [number, number][] = [];
    const hasServerLandings = hourlyLandings && hourlyLandings.length > 0;

    if (showDrift) {
      const driftGroup = L.layerGroup().addTo(map);

      if (hasServerLandings) {
        // GFS-based predictions from simulation backend
        hourlyLandings!.forEach((pred, ci) => {
          const color = DRIFT_COLORS[ci % DRIFT_COLORS.length];
          const label = new Date(pred.hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          driftLatLons.push([pred.lat, pred.lon]);
          L.marker([pred.lat, pred.lon], {
            icon: L.divIcon({
              html: `<div style="width:10px;height:10px;background:${color};border-radius:50%;border:2px solid #fff;box-shadow:0 0 4px rgba(0,0,0,.6)"></div>`,
              className: '', iconSize: [10, 10], iconAnchor: [5, 5],
            }),
          })
            .bindPopup(`<b>GFS Landing Prediction</b><br>${label}<br>Lat: ${pred.lat.toFixed(5)}<br>Lon: ${pred.lon.toFixed(5)}`)
            .addTo(driftGroup);
          L.marker([pred.lat, pred.lon], {
            icon: L.divIcon({
              html: `<div style="font-size:10px;color:${color};font-weight:600;white-space:nowrap;text-shadow:0 0 3px #000,0 0 3px #000">${label}</div>`,
              className: '', iconSize: [50, 14], iconAnchor: [25, 20],
            }),
            interactive: false, zIndexOffset: -1,
          }).addTo(driftGroup);
        });

      } else if (weatherData) {
        // Fallback: open-meteo client-side predictions (pre-simulation)
        const hourly = weatherData.hourly;
        const times = hourly.time as string[];
        const speedToMs = weatherIsImperial ? 0.44704 : (1 / 3.6);
        const pivot = launchDateTime ?? new Date().toISOString().slice(0, 16);
        const pivotMs = new Date(pivot).getTime();
        const driftHours: { idx: number; label: string }[] = [];
        for (let i = 0; i < times.length && driftHours.length < 8; i++) {
          const tMs = new Date(times[i]).getTime();
          if (tMs < pivotMs - 3 * 3600_000) continue;
          if (tMs > pivotMs + 21 * 3600_000) break;
          if ((new Date(times[i]).getHours()) % 3 !== 0) continue;
          driftHours.push({ idx: i, label: new Date(times[i]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
        }
        driftHours.forEach(({ idx, label }, ci) => {
          const [pLat, pLon] = predictLanding(
            trajectory, apogeeTimeS, launchLat, launchLon,
            launchElevationM, hourly, idx, speedToMs,
          );
          driftLatLons.push([pLat, pLon]);
          const color = DRIFT_COLORS[ci % DRIFT_COLORS.length];
          L.marker([pLat, pLon], {
            icon: L.divIcon({
              html: `<div style="width:10px;height:10px;background:${color};border-radius:50%;border:2px solid #fff;box-shadow:0 0 4px rgba(0,0,0,.6)"></div>`,
              className: '', iconSize: [10, 10], iconAnchor: [5, 5],
            }),
          })
            .bindPopup(`<b>Predicted Landing</b><br>${label}<br>Lat: ${pLat.toFixed(5)}<br>Lon: ${pLon.toFixed(5)}`)
            .addTo(driftGroup);
          L.marker([pLat, pLon], {
            icon: L.divIcon({
              html: `<div style="font-size:10px;color:${color};font-weight:600;white-space:nowrap;text-shadow:0 0 3px #000,0 0 3px #000">${label}</div>`,
              className: '', iconSize: [50, 14], iconAnchor: [25, 20],
            }),
            interactive: false, zIndexOffset: -1,
          }).addTo(driftGroup);
        });
      }
    }

    // ── Aircraft overlay ───────────────────────────────────────────────────────
    if (showAircraft && aircraft.length > 0) {
      const acGroup = L.layerGroup().addTo(map);
      for (const ac of aircraft) {
        const altFt = Math.round(ac.alt_m * M_FT);
        const speedKt = Math.round(ac.velocity_ms * 1.94384);
        L.marker([ac.lat, ac.lon], { icon: aircraftIcon(ac.heading) })
          .bindPopup(
            `<b>${ac.callsign}</b><br>` +
            `Alt: ${altFt.toLocaleString()} ft<br>` +
            `Speed: ${speedKt} kt<br>` +
            `Hdg: ${Math.round(ac.heading)}°`
          )
          .addTo(acGroup);
      }
    }

    // Fit map to trajectory + all drift prediction bounds
    const bounds = L.latLngBounds(latLons);
    driftLatLons.forEach(ll => bounds.extend(ll));
    if (showAircraft && aircraft.length > 0) {
      for (const ac of aircraft) bounds.extend([ac.lat, ac.lon]);
    }
    map.fitBounds(bounds, { padding: [40, 40] });

    return () => {
      map.remove();
      leafletMap.current = null;
    };
  }, [trajectory, launchLat, launchLon, launchElevationM, apogeeTimeS, burnOutTimeS, weatherData, showDrift, showAircraft, aircraft, weatherIsImperial, launchDateTime, hourlyLandings]);

  return (
    <div className="bg-gray-900 rounded-xl p-4">
      <div className="flex items-center justify-between mb-0.5">
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">Map Trajectory</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowAircraft(v => !v)}
            className={`text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${
              showAircraft
                ? 'bg-amber-600/20 border-amber-500/40 text-amber-300 hover:bg-amber-600/30'
                : 'bg-gray-800 border-gray-700 text-gray-500 hover:text-white'
            }`}
          >
            {showAircraft ? 'Hide aircraft' : 'Show aircraft'}
            {showAircraft && aircraft.length > 0 && <span className="ml-1.5 text-[10px] opacity-60">{aircraft.length}</span>}
          </button>
          {(hourlyLandings?.length || weatherData) && (
            <button
              onClick={() => setShowDrift(v => !v)}
              className={`text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${
                showDrift
                  ? 'bg-blue-600/20 border-blue-500/40 text-blue-300 hover:bg-blue-600/30'
                  : 'bg-gray-800 border-gray-700 text-gray-500 hover:text-white'
              }`}
            >
              {showDrift ? 'Hide landing forecast' : 'Show landing forecast'}
              {hourlyLandings?.length ? <span className="ml-1.5 text-[10px] opacity-60">GFS</span> : null}
            </button>
          )}
          {kmlData && (
            <button
              onClick={() => downloadKml(kmlData)}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Download KML
            </button>
          )}
        </div>
      </div>
      <p className="text-gray-600 text-xs mb-3">
        Satellite overlay · altitude color gradient (blue → red) · click markers for details
        {showAircraft ? ' · yellow planes = live aircraft' : null}
        {showDrift && hourlyLandings?.length ? ' · colored dots = predicted landing per forecast hour' : showDrift && weatherData ? ' · colored dots = predicted landing per forecast hour' : null}
      </p>
      <div ref={mapRef} className="rounded-lg overflow-hidden" style={{ height: 480 }} />
      {/* Altitude legend */}
      <div className="flex items-center gap-2 mt-2">
        <span className="text-xs text-gray-600">Low</span>
        <div className="flex-1 h-2 rounded" style={{
          background: 'linear-gradient(to right, rgb(59,130,246), rgb(34,211,238), rgb(74,222,128), rgb(250,204,21), rgb(239,68,68))'
        }} />
        <span className="text-xs text-gray-600">High altitude</span>
      </div>
    </div>
  );
}