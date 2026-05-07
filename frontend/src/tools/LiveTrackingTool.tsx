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
