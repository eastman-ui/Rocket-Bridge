import { useEffect, useRef, useState, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { UnitSystem } from './TimeSeriesCharts';
import { nowRoundedLocalISO } from '../App';

// Fix Leaflet default icon URLs broken by bundlers
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

interface NominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
}

async function fetchElevation(lat: number, lon: number): Promise<number | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(
      `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`,
      { signal: ctrl.signal },
    );
    clearTimeout(t);
    const json = await res.json();
    return json?.elevation?.[0] ?? null;
  } catch {
    return null;
  }
}

function LocationPicker({
  lat,
  lon,
  onSelect,
  disabled,
}: {
  lat: number;
  lon: number;
  onSelect: (lat: number, lon: number, elev: number | null) => void;
  disabled: boolean;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<NominatimResult[]>([]);
  const [dropOpen, setDropOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);

  // Nominatim search (debounced 400ms)
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (query.length < 2) { setResults([]); setDropOpen(false); return; }
    timerRef.current = setTimeout(async () => {
      try {
        const r = await fetch(
          `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=6`,
          { headers: { 'Accept-Language': 'en' } },
        );
        const j: NominatimResult[] = await r.json();
        setResults(j);
        setDropOpen(j.length > 0);
      } catch { /* ignore */ }
    }, 400);
  }, [query]);

  // Close dropdown on outside click
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node))
        setDropOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const handlePick = useCallback(async (newLat: number, newLon: number) => {
    const elev = await fetchElevation(newLat, newLon);
    onSelect(newLat, newLon, elev);
  }, [onSelect]);

  // Init Leaflet map when shown
  useEffect(() => {
    if (!mapOpen || !mapDivRef.current || mapRef.current) return;
    const map = L.map(mapDivRef.current, { center: [lat, lon], zoom: 12, zoomAnimation: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
    }).addTo(map);
    const marker = L.marker([lat, lon], { draggable: true }).addTo(map);
    marker.on('dragend', () => {
      const p = marker.getLatLng();
      handlePick(parseFloat(p.lat.toFixed(6)), parseFloat(p.lng.toFixed(6)));
    });
    map.on('click', (e: L.LeafletMouseEvent) => {
      const p = e.latlng;
      marker.setLatLng(p);
      handlePick(parseFloat(p.lat.toFixed(6)), parseFloat(p.lng.toFixed(6)));
    });
    mapRef.current = map;
    markerRef.current = marker;
    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  // Only re-init when map is opened — lat/lon tracked via separate effect
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapOpen]);

  // Keep marker in sync when lat/lon changes externally
  useEffect(() => {
    if (!mapRef.current || !markerRef.current) return;
    markerRef.current.setLatLng([lat, lon]);
  }, [lat, lon]);

  // Resize fix when map div becomes visible
  useEffect(() => {
    if (!mapOpen || !mapRef.current) return;
    setTimeout(() => mapRef.current?.invalidateSize(), 50);
  }, [mapOpen]);

  const selectResult = async (r: NominatimResult) => {
    const newLat = parseFloat(parseFloat(r.lat).toFixed(6));
    const newLon = parseFloat(parseFloat(r.lon).toFixed(6));
    setQuery('');
    setDropOpen(false);
    // Pan map if open
    if (mapRef.current && markerRef.current) {
      mapRef.current.setView([newLat, newLon], 14);
      markerRef.current.setLatLng([newLat, newLon]);
    }
    const elev = await fetchElevation(newLat, newLon);
    onSelect(newLat, newLon, elev);
  };

  return (
    <div ref={containerRef} className="col-span-2 space-y-2">
      {/* Search row */}
      <div className="relative flex gap-2">
        <div className="relative flex-1">
          <input
            type="text"
            placeholder="Search launch site or place name…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            disabled={disabled}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 disabled:opacity-40 disabled:cursor-not-allowed placeholder-gray-600"
          />
          {dropOpen && results.length > 0 && (
            <div className="absolute z-30 w-full bg-gray-800 border border-gray-700 rounded-lg mt-1 shadow-xl overflow-hidden">
              {results.map(r => (
                <button
                  key={r.place_id}
                  type="button"
                  onClick={() => selectResult(r)}
                  className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-gray-700 transition-colors border-b border-gray-700/50 last:border-0"
                >
                  <span className="block truncate">{r.display_name}</span>
                  <span className="text-gray-500 text-xs tabular-nums">
                    {parseFloat(r.lat).toFixed(4)}, {parseFloat(r.lon).toFixed(4)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setMapOpen(o => !o)}
          disabled={disabled}
          title={mapOpen ? 'Hide map' : 'Pick on map'}
          className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            mapOpen
              ? 'bg-blue-600 text-white hover:bg-blue-500'
              : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-white border border-gray-700'
          }`}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round"
              d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
          </svg>
          Map
        </button>
      </div>

      {/* Leaflet map */}
      {mapOpen && (
        <div className="rounded-lg overflow-hidden border border-gray-700">
          <div ref={mapDivRef} style={{ height: 260 }} />
          <p className="text-xs text-gray-500 px-2 py-1 bg-gray-850 border-t border-gray-700">
            Click map or drag pin to set location
          </p>
        </div>
      )}
    </div>
  );
}

export interface LaunchConfig {
  lat: number;
  lon: number;
  elevation: number;   // always stored in meters
  railLength: number;  // always stored in meters
  inclination: number;
  heading: number;
  useLiveWeather: boolean;
  weatherDateTime: string;
}

interface LaunchConfigProps {
  config: LaunchConfig;
  onChange: (config: LaunchConfig) => void;
  disabled: boolean;
  unitSystem: UnitSystem;
  orRailLengthM?: number;
}

const M_FT = 3.28084;

function Field({
  label,
  unit,
  value,
  field,
  config,
  onChange,
  disabled,
  step,
  scale = 1,
}: {
  label: string;
  unit?: string;
  value: number;
  field: keyof LaunchConfig;
  config: LaunchConfig;
  onChange: (config: LaunchConfig) => void;
  disabled: boolean;
  step?: number;
  scale?: number;
}) {
  const displayValue = parseFloat((value * scale).toFixed(scale === 1 ? 3 : 1));
  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm text-gray-400">
        {label}
        {unit && <span className="ml-1 text-gray-500">{unit}</span>}
      </label>
      <input
        type="number"
        value={displayValue}
        step={step ?? 1}
        disabled={disabled}
        onChange={(e) =>
          onChange({ ...config, [field]: parseFloat(e.target.value) / scale })
        }
        className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
      />
    </div>
  );
}

export default function LaunchConfigForm({
  config,
  onChange,
  disabled,
  unitSystem,
  orRailLengthM,
}: LaunchConfigProps) {
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState<string | null>(null);
  const imp = unitSystem === 'imperial';

  const handleLocationPick = (lat: number, lon: number, elev: number | null) => {
    onChange({
      ...config,
      lat,
      lon,
      ...(elev != null ? { elevation: Math.round(elev) } : {}),
    });
  };

  const handleUseMyLocation = () => {
    if (!navigator.geolocation) {
      setLocError('Geolocation not supported by this browser.');
      return;
    }
    setLocating(true);
    setLocError(null);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = parseFloat(pos.coords.latitude.toFixed(5));
        const lon = parseFloat(pos.coords.longitude.toFixed(5));
        const elev = await fetchElevation(lat, lon);
        onChange({ ...config, lat, lon, ...(elev != null ? { elevation: Math.round(elev) } : {}) });
        setLocating(false);
      },
      (err) => {
        setLocError(err.message);
        setLocating(false);
      },
      { timeout: 10000 },
    );
  };

  return (
    <div className="bg-gray-900 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">Launch Configuration</h2>
        <button
          type="button"
          onClick={handleUseMyLocation}
          disabled={disabled || locating}
          title="Use my location"
          className="flex items-center justify-center w-8 h-8 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {locating ? (
            <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          ) : (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <circle cx="12" cy="12" r="4" />
              <path strokeLinecap="round" d="M12 2v3M12 19v3M2 12h3M19 12h3" />
            </svg>
          )}
        </button>
      </div>
      {locError && (
        <p className="text-xs text-red-400">{locError}</p>
      )}

      <div className="grid grid-cols-2 gap-3">
        <LocationPicker
          lat={config.lat}
          lon={config.lon}
          onSelect={handleLocationPick}
          disabled={disabled}
        />
        <Field
          label="Latitude"
          unit="°"
          value={config.lat}
          field="lat"
          config={config}
          onChange={onChange}
          disabled={disabled}
          step={0.001}
        />
        <Field
          label="Longitude"
          unit="°"
          value={config.lon}
          field="lon"
          config={config}
          onChange={onChange}
          disabled={disabled}
          step={0.001}
        />
        <Field
          label="Elevation"
          unit={imp ? 'ft' : 'm'}
          value={config.elevation}
          field="elevation"
          config={config}
          onChange={onChange}
          disabled={disabled}
          step={imp ? 10 : 1}
          scale={imp ? M_FT : 1}
        />
        <div className="flex flex-col gap-1">
          {(() => {
            const isImported = orRailLengthM != null && Math.abs(config.railLength - orRailLengthM) < 0.001;
            return (
              <>
                <div className="flex items-center gap-1">
                  <label className={`text-sm ${isImported ? 'text-blue-400' : 'text-gray-400'}`}>
                    Rail Length
                    <span className={`ml-1 ${isImported ? 'text-blue-500' : 'text-gray-500'}`}>{imp ? 'ft' : 'm'}</span>
                  </label>
                  {isImported && (
                    <span className="relative group inline-flex items-center">
                      <svg className="w-3 h-3 text-blue-500 cursor-help" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <circle cx="12" cy="12" r="10" />
                        <path strokeLinecap="round" d="M12 16v-4M12 8h.01" />
                      </svg>
                      <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 text-xs bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-2 text-gray-300 invisible group-hover:visible z-20 shadow-xl leading-relaxed whitespace-normal">
                        Imported from .ork file
                      </span>
                    </span>
                  )}
                </div>
                <input
                  type="number"
                  value={parseFloat((config.railLength * (imp ? M_FT : 1)).toFixed(imp ? 1 : 3))}
                  step={imp ? 0.5 : 0.1}
                  disabled={disabled}
                  onChange={(e) =>
                    onChange({ ...config, railLength: parseFloat(e.target.value) / (imp ? M_FT : 1) })
                  }
                  className={`bg-gray-800 border rounded-lg px-3 py-2 text-white text-sm focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed ${isImported ? 'border-blue-700 focus:border-blue-400' : 'border-gray-700 focus:border-blue-500'}`}
                />
              </>
            );
          })()}
        </div>
        <Field
          label="Inclination"
          unit="°"
          value={config.inclination}
          field="inclination"
          config={config}
          onChange={onChange}
          disabled={disabled}
          step={1}
        />
        <Field
          label="Heading"
          unit="°"
          value={config.heading}
          field="heading"
          config={config}
          onChange={onChange}
          disabled={disabled}
          step={1}
        />
      </div>

      <div className="flex items-start gap-3 pt-1">
        <input
          id="live-weather"
          type="checkbox"
          checked={config.useLiveWeather}
          disabled={disabled}
          onChange={(e) => {
            const next = e.target.checked;
            const update: Partial<LaunchConfig> = { useLiveWeather: next };
            if (next) update.weatherDateTime = nowRoundedLocalISO();
            onChange({ ...config, ...update });
          }}
          className="mt-0.5 accent-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
        />
        <div className="flex-1">
          <label
            htmlFor="live-weather"
            className="text-sm text-gray-300 cursor-pointer select-none"
          >
            Use live weather (NOMADS GFS)
          </label>
          {config.useLiveWeather && (
            <div className="mt-2 space-y-1">
              <label className="text-xs text-gray-400">Forecast date/time (local)</label>
              <input
                type="datetime-local"
                value={config.weatherDateTime}
                disabled={disabled}
                onChange={(e) => onChange({ ...config, weatherDateTime: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500 disabled:opacity-40 disabled:cursor-not-allowed"
              />
              <p className="text-xs text-gray-600">GFS runs every 6 h — fetches nearest 00/06/12/18 UTC run.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
