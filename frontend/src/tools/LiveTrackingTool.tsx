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
