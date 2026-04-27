import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Trajectory3D } from '../types';

interface Props {
  trajectory: Trajectory3D;
  launchLat: number;
  launchLon: number;
  launchElevationM: number;
  apogeeTimeS: number;
  burnOutTimeS: number;
  kmlData?: string;
}

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
  // blue (low) → cyan → green → yellow → red (high)
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

export function TrajectoryMap({
  trajectory, launchLat, launchLon, launchElevationM,
  apogeeTimeS, burnOutTimeS, kmlData,
}: Props) {
  const mapRef = useRef<HTMLDivElement>(null);
  const leafletMap = useRef<L.Map | null>(null);

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

    // Fit map to trajectory bounds
    const bounds = L.latLngBounds(latLons);
    map.fitBounds(bounds, { padding: [40, 40] });

    return () => {
      map.remove();
      leafletMap.current = null;
    };
  }, [trajectory, launchLat, launchLon, launchElevationM, apogeeTimeS, burnOutTimeS]);

  return (
    <div className="bg-gray-900 rounded-xl p-4">
      <div className="flex items-center justify-between mb-0.5">
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">Map Trajectory</h2>
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
      <p className="text-gray-600 text-xs mb-3">
        Satellite overlay · altitude color gradient (blue → red) · click markers for details
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
