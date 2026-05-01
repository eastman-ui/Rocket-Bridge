import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { LaunchConfig } from '../components/LaunchConfig';
import type { UnitSystem } from '../components/TimeSeriesCharts';

interface Props {
  config: LaunchConfig;
  unitSystem: UnitSystem;
  apogeeM?: number;
}

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

interface Notam {
  notamID: string;
  location?: string;
  text?: string;
  startTime?: string;
  endTime?: string;
  coordinates?: { lat: number; lon: number };
  radius?: number;
  altLower?: string;
  altUpper?: string;
}

const M_FT = 3.28084;
const REFRESH_INTERVAL = 120; // 120s → ~720 req/day well within OpenSky 400/day anonymous limit

function aircraftIcon(heading: number): L.DivIcon {
  return L.divIcon({
    className: '',
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    html: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"
             style="transform:rotate(${heading}deg)">
             <polygon points="12,2 16,20 12,16 8,20" fill="#f59e0b" stroke="#92400e" stroke-width="1"/>
           </svg>`,
  });
}


export function AirspaceTool({ config, unitSystem, apogeeM }: Props) {
  const imp = unitSystem === 'imperial';
  const mapRef = useRef<HTMLDivElement>(null);
  const leafletMap = useRef<L.Map | null>(null);
  const acLayerRef = useRef<L.LayerGroup | null>(null);
  const notamLayerRef = useRef<L.LayerGroup | null>(null);
  const launchMarkerRef = useRef<L.CircleMarker | null>(null);

  const [aircraft, setAircraft] = useState<Aircraft[]>([]);
  const [notams, setNotams] = useState<Notam[]>([]);
  const [loadingAc, setLoadingAc] = useState(false);
  const [loadingNotam, setLoadingNotam] = useState(false);
  const [errorAc, setErrorAc] = useState<string | null>(null);
  const [errorNotam, setErrorNotam] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL);
  const [showAc, setShowAc] = useState(true);
  const [showNotam, setShowNotam] = useState(true);
  const [radius, setRadius] = useState(1.0); // degrees
  const [altFilter] = useState<[number, number]>([0, 18000]); // meters
  const [localLat, setLocalLat] = useState(config.lat);
  const [localLon, setLocalLon] = useState(config.lon);
  const [mapReady, setMapReady] = useState(false);

  // Sync with launch config when it changes (e.g., cache restore)
  useEffect(() => {
    setLocalLat(config.lat);
    setLocalLon(config.lon);
  }, [config.lat, config.lon]);
  const [locating, setLocating] = useState(false);

  const bbox = {
    lamin: localLat - radius,
    lamax: localLat + radius,
    lomin: localLon - radius,
    lomax: localLon + radius,
  };

  const fetchAircraft = async () => {
    setLoadingAc(true);
    setErrorAc(null);
    try {
      const url = `/api/airspace/aircraft?lamin=${bbox.lamin}&lomin=${bbox.lomin}&lamax=${bbox.lamax}&lomax=${bbox.lomax}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const states: Aircraft[] = (j.aircraft ?? [])
        .filter((a: any) => !a.on_ground && a.alt_m >= altFilter[0] && a.alt_m <= altFilter[1]);
      setAircraft(states);
    } catch (e: any) {
      setErrorAc(e.message);
    } finally {
      setLoadingAc(false);
    }
  };

  const [notamUnavailable, setNotamUnavailable] = useState(false);

  const fetchNotams = async () => {
    setLoadingNotam(true);
    setErrorNotam(null);
    try {
      const url = `/api/airspace/notams?lamin=${bbox.lamin}&lomin=${bbox.lomin}&lamax=${bbox.lamax}&lomax=${bbox.lomax}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j.unavailable) { setNotamUnavailable(true); setNotams([]); return; }
      const items: Notam[] = (Array.isArray(j) ? j : j.items ?? []).map((n: any) => ({
        notamID: n.notamID ?? n.id ?? '—',
        location: n.location ?? n.icaoLocation,
        text: n.text ?? n.traditionalMessage ?? n.message,
        startTime: n.effectiveStart ?? n.startDate,
        endTime: n.effectiveEnd ?? n.endDate,
        altLower: n.lowerLimit,
        altUpper: n.upperLimit,
      }));
      setNotamUnavailable(false);
      setNotams(items);
    } catch (e: any) {
      setErrorNotam(e.message);
    } finally {
      setLoadingNotam(false);
    }
  };

  // Init map — wait until container is visible (handles hidden-on-mount case)
  useEffect(() => {
    const el = mapRef.current;
    if (!el) return;
    let observer: IntersectionObserver | null = null;

    const initMap = () => {
      if (leafletMap.current || !el) return;
      const map = L.map(el, { center: [localLat, localLon], zoom: 8, zoomAnimation: false });
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '© CartoDB', maxZoom: 18,
      }).addTo(map);
      const marker = L.circleMarker([localLat, localLon], { radius: 8, color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.8 })
        .bindPopup(`<b>Launch Site</b><br>${localLat.toFixed(4)}, ${localLon.toFixed(4)}`)
        .addTo(map);
      launchMarkerRef.current = marker;
      acLayerRef.current = L.layerGroup().addTo(map);
      notamLayerRef.current = L.layerGroup().addTo(map);
      leafletMap.current = map;
      setMapReady(true);
    };

    if (el.offsetParent !== null) {
      initMap();
    } else {
      observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) {
          observer?.disconnect();
          observer = null;
          setTimeout(initMap, 50);
        }
      }, { threshold: 0 });
      observer.observe(el);
    }

    return () => {
      observer?.disconnect();
      if (leafletMap.current) { leafletMap.current.remove(); leafletMap.current = null; }
      setMapReady(false);
    };
  }, []);

  // Resize map when container becomes visible (tab/page switch)
  useEffect(() => {
    const map = leafletMap.current;
    const el = mapRef.current;
    if (!map || !el) return;
    const obs = new ResizeObserver(() => { map.invalidateSize(); });
    obs.observe(el);
    return () => obs.disconnect();
  }, [leafletMap.current]);

  // Re-center map and move launch marker when coordinates change
  useEffect(() => {
    const map = leafletMap.current;
    const marker = launchMarkerRef.current;
    if (!map) return;
    map.setView([localLat, localLon], map.getZoom());
    if (marker) {
      marker.setLatLng([localLat, localLon]);
      marker.bindPopup(`<b>Launch Site</b><br>${localLat.toFixed(4)}, ${localLon.toFixed(4)}`);
    }
  }, [localLat, localLon]);

  // Update aircraft layer
  useEffect(() => {
    const layer = acLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!showAc) return;
    aircraft.forEach(ac => {
      const altDisp = imp ? Math.round(ac.alt_m * M_FT).toLocaleString() + ' ft' : Math.round(ac.alt_m).toLocaleString() + ' m';
      const spdDisp = imp ? Math.round(ac.velocity_ms * 2.23694) + ' mph' : Math.round(ac.velocity_ms) + ' m/s';
      const m = L.marker([ac.lat, ac.lon], { icon: aircraftIcon(ac.heading) })
        .bindPopup(`<b>${ac.callsign}</b><br>Alt: ${altDisp}<br>Speed: ${spdDisp}<br>Heading: ${ac.heading}°`);
      layer.addLayer(m);
    });
  }, [aircraft, showAc, imp, mapReady]);

  // Update NOTAM layer
  useEffect(() => {
    const layer = notamLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!showNotam) return;
    notams.forEach(n => {
      if (n.coordinates) {
        const r = (n.radius ?? 5) * 1852; // nm → m
        L.circle([n.coordinates.lat, n.coordinates.lon], {
          radius: r, color: '#ef4444', fillColor: '#ef4444', fillOpacity: 0.1, weight: 1.5,
        }).bindPopup(`<b>${n.notamID}</b><br>${(n.text ?? '').slice(0, 200)}`).addTo(layer);
      }
    });
  }, [notams, showNotam, mapReady]);

  // Initial fetch + re-fetch when location or radius changes
  useEffect(() => {
    fetchAircraft();
    fetchNotams();
  }, [radius, altFilter[0], altFilter[1], localLat, localLon]);

  useEffect(() => {
    const interval = setInterval(() => {
      // Skip tick if tab/page not visible — don't waste API quota in background
      if (document.hidden) return;
      setCountdown(c => {
        if (c <= 1) { fetchAircraft(); return REFRESH_INTERVAL; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const apogeeAlt = apogeeM ?? 0;
  const apogeeAltDisp = imp ? `${Math.round(apogeeAlt * M_FT).toLocaleString()} ft` : `${Math.round(apogeeAlt).toLocaleString()} m`;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-sm font-semibold text-gray-200 uppercase tracking-wide">Airspace</h3>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-gray-500">Auto-refresh in <span className="text-gray-300 tabular-nums">{countdown}s</span> <span className="text-gray-700">(2 min)</span></span>
          <button onClick={() => { fetchAircraft(); fetchNotams(); setCountdown(REFRESH_INTERVAL); }}
            className="bg-gray-800 hover:bg-gray-700 text-gray-300 px-2.5 py-1 rounded-lg transition-colors">
            Refresh now
          </button>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={showAc} onChange={e => setShowAc(e.target.checked)} className="accent-yellow-500" />
          <span className="text-yellow-400">Aircraft ({aircraft.length})</span>
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={showNotam} onChange={e => setShowNotam(e.target.checked)} className="accent-red-500" />
          <span className="text-red-400">NOTAMs ({notams.length})</span>
        </label>
        <div className="flex items-center gap-1.5">
          <span className="text-gray-500">Radius</span>
          <select value={radius} onChange={e => setRadius(Number(e.target.value))}
            className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-gray-300">
            {[0.5, 1, 1.5, 2, 3].map(r => <option key={r} value={r}>{r}°</option>)}
          </select>
        </div>
        <button
          onClick={() => {
            setLocating(true);
            navigator.geolocation.getCurrentPosition(
              pos => { setLocalLat(pos.coords.latitude); setLocalLon(pos.coords.longitude); setLocating(false); },
              () => setLocating(false),
              { enableHighAccuracy: true, timeout: 10000 },
            );
          }}
          disabled={locating}
          className="bg-gray-800 hover:bg-gray-700 text-gray-300 px-2 py-0.5 rounded transition-colors disabled:opacity-50"
          title="Use current location"
        >
          {locating ? '…' : '📍 My location'}
        </button>
        {apogeeAlt > 0 && (
          <span className="text-gray-600">Expected apogee: <span className="text-blue-400">{apogeeAltDisp}</span></span>
        )}
        {(loadingAc || loadingNotam) && (
          <div className="w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        )}
      </div>
      <div className="text-xs text-gray-500">
        Center: <span className="text-gray-300">{localLat.toFixed(4)}, {localLon.toFixed(4)}</span>
      </div>

      {errorAc && (
        <div className="text-xs text-red-400 bg-red-950/40 border border-red-800 rounded-lg px-3 py-2">
          Aircraft: {errorAc}
        </div>
      )}
      {errorNotam && (
        <div className="text-xs text-red-400 bg-red-950/40 border border-red-800 rounded-lg px-3 py-2">
          NOTAMs: {errorNotam}
        </div>
      )}
      {notamUnavailable && (
        <div className="text-xs text-gray-500 bg-gray-800/40 border border-gray-700/50 rounded-lg px-3 py-2">
          <p>NOTAM data is not available.</p>
        </div>
      )}

      {/* Map */}
      <div ref={mapRef} className="w-full rounded-xl overflow-hidden" style={{ height: 480 }} />

      {/* NOTAM list */}
      {notams.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-gray-500 uppercase tracking-wide font-semibold">Active NOTAMs ({notams.length})</p>
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {notams.map((n, i) => (
              <details key={i} className="bg-gray-800/50 rounded-lg px-3 py-2 group">
                <summary className="text-xs text-gray-300 cursor-pointer list-none flex items-start justify-between gap-2">
                  <span className="font-mono font-semibold text-red-400">{n.notamID}</span>
                  <span className="text-gray-500 truncate flex-1">{(n.text ?? '').slice(0, 80)}{(n.text ?? '').length > 80 ? '…' : ''}</span>
                  {n.altLower && <span className="text-gray-600 shrink-0">{n.altLower}–{n.altUpper ?? 'UNL'}</span>}
                </summary>
                <p className="text-xs text-gray-400 mt-2 font-mono whitespace-pre-wrap">{n.text}</p>
                {n.startTime && <p className="text-xs text-gray-600 mt-1">{n.startTime} → {n.endTime ?? 'PERM'}</p>}
              </details>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
