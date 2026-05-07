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
  frac = Math.max(0, Math.min(1, frac));
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

function predictLanding(points: GpsPoint[], launchAltM = 0): [number, number] | null {
  const n = points.length;
  if (n < 4) return null;
  const cur = points[n - 1];
  const old = points[n - 4];
  if (cur.alt_m >= old.alt_m) return null; // not descending
  if (cur.speed_ms == null || cur.heading_deg == null) return null;
  const dt = cur.t - old.t;
  if (dt <= 0) return null;
  const descentRate = (cur.alt_m - old.alt_m) / dt; // negative m/s
  const altAGL = cur.alt_m - launchAltM;
  if (altAGL <= 0) return null;
  const timeToGround = altAGL / Math.abs(descentRate);
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
  const connectingRef = useRef(false);
  const pointsRef = useRef<GpsPoint[]>([]);
  const launchAltRef = useRef(0);
  const launchSetRef = useRef(false);

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

  // ── Map resize observer (fixes blank map on tab switch) ───────────────────
  useEffect(() => {
    const div = mapDivRef.current;
    if (!div) return;
    const ro = new ResizeObserver(() => { leafletMap.current?.invalidateSize(); });
    ro.observe(div);
    return () => ro.disconnect();
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
    return () => { if (waiverCircle.current) { map.removeLayer(waiverCircle.current); waiverCircle.current = null; } };
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
    return () => { if (launchMarker.current) { map.removeLayer(launchMarker.current); launchMarker.current = null; } };
  }, [launchLat, launchLon]);

  // ── Imperative track update ────────────────────────────────────────────────
  const addPointToMap = useCallback((point: GpsPoint, allPoints: GpsPoint[]) => {
    const map = leafletMap.current;
    if (!map) return;
    const n = allPoints.length;
    const minAlt = allPoints.reduce((m, p) => p.alt_m < m ? p.alt_m : m, Infinity);
    const maxAlt = allPoints.reduce((m, p) => p.alt_m > m ? p.alt_m : m, -Infinity);
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
    const pred = predictLanding(allPoints, launchAltRef.current);
    if (pred) {
      landingMarker.current = L.marker(pred, {
        icon: L.divIcon({
          html: '<div style="width:12px;height:12px;background:#f59e0b;border-radius:50%;border:2px solid #fff;box-shadow:0 0 6px rgba(245,158,11,.8)"></div>',
          className: '', iconSize: [12, 12], iconAnchor: [6, 6],
        }),
      }).bindPopup('<b>Predicted Landing</b>').addTo(map);
    }
  }, []);

  // ── Serial connection ──────────────────────────────────────────────────────
  async function connect() {
    if (!HAS_SERIAL || portRef.current || connectingRef.current) return;
    connectingRef.current = true;
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
            if (!launchSetRef.current) {
              launchSetRef.current = true;
              launchAltRef.current = pt.alt_m;
              setLaunchLat(String(pt.lat));
              setLaunchLon(String(pt.lon));
            }
            const next = [...pointsRef.current, pt];
            pointsRef.current = next;
            setPoints(next);
            addPointToMap(pt, next);
          }
        }
      } catch { /* serial read error or device unplugged */ }
      finally { reader.releaseLock(); }
      try { await port.close(); } catch { /* ignore */ }
    } catch { /* user denied port access */ }
    setStatus('disconnected');
    portRef.current = null;
    readerRef.current = null;
    connectingRef.current = false;
  }

  async function disconnect() {
    try { await readerRef.current?.cancel(); } catch { /* ignore */ }
    // port.close() is handled by the read loop after reader.releaseLock()
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
    pointsRef.current = [];
    launchSetRef.current = false;
    launchAltRef.current = 0;
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

  // ── Derived display values ─────────────────────────────────────────────────
  const connected = status !== 'disconnected';
  const cur = points[points.length - 1];
  const maxAltVal = points.reduce((m, p) => (p.alt_m > m ? p.alt_m : m), -Infinity);
  const altScale = imp ? 3.28084 : 1;
  const altUnit = imp ? 'ft' : 'm';
  const speedScale = imp ? 2.23694 : 1;
  const speedUnit = imp ? 'mph' : 'm/s';
  const statusColor = status === 'live' ? 'text-green-400' : status === 'connected' ? 'text-yellow-400' : 'text-gray-500';
  const statusLabel = status === 'live' ? 'Live' : status === 'connected' ? 'Connected — no fix' : 'Disconnected';

  const stats = [
    { label: 'Alt', value: cur ? `${Math.round(cur.alt_m * altScale).toLocaleString()} ${altUnit}` : '—' },
    { label: 'Max Alt', value: Number.isFinite(maxAltVal) ? `${Math.round(maxAltVal * altScale).toLocaleString()} ${altUnit}` : '—' },
    { label: 'Speed', value: cur?.speed_ms != null ? `${(cur.speed_ms * speedScale).toFixed(1)} ${speedUnit}` : '—' },
    { label: 'Heading', value: cur?.heading_deg != null ? `${Math.round(cur.heading_deg)}°` : '—' },
    { label: 'Fixes', value: String(points.length) },
    { label: 'Elapsed', value: cur ? `${cur.t.toFixed(0)} s` : '—' },
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
              ? 'bg-red-800 hover:bg-red-700 text-white disabled:opacity-40 disabled:cursor-not-allowed'
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
