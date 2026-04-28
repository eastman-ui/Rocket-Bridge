import { useEffect, useRef, useState } from 'react';
import type { UnitSystem } from './TimeSeriesCharts';
import { nowRoundedLocalISO } from '../App';

interface GeoResult {
  id: number;
  name: string;
  admin1?: string;
  country?: string;
  latitude: number;
  longitude: number;
  elevation?: number;
}

function CitySearch({ onSelect, disabled }: {
  onSelect: (r: GeoResult) => void;
  disabled: boolean;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GeoResult[]>([]);
  const [open, setOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (query.length < 2) { setResults([]); setOpen(false); return; }
    timerRef.current = setTimeout(async () => {
      try {
        const r = await fetch(
          `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=6&language=en&format=json`
        );
        const j = await r.json();
        setResults(j.results ?? []);
        setOpen(true);
      } catch { /* ignore */ }
    }, 300);
  }, [query]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={containerRef} className="relative col-span-2">
      <input
        type="text"
        placeholder="Search city to auto-fill coordinates..."
        value={query}
        onChange={e => setQuery(e.target.value)}
        disabled={disabled}
        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 disabled:opacity-40 disabled:cursor-not-allowed placeholder-gray-600"
      />
      {open && results.length > 0 && (
        <div className="absolute z-20 w-full bg-gray-800 border border-gray-700 rounded-lg mt-1 shadow-xl overflow-hidden">
          {results.map(r => (
            <button
              key={r.id}
              type="button"
              onClick={() => { onSelect(r); setQuery(''); setOpen(false); }}
              className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-gray-700 transition-colors border-b border-gray-700/50 last:border-0"
            >
              <span className="font-medium">{r.name}</span>
              {r.admin1 && <span className="text-gray-500">, {r.admin1}</span>}
              {r.country && <span className="text-gray-500">, {r.country}</span>}
              <span className="float-right text-gray-600 text-xs tabular-nums">
                {r.latitude.toFixed(2)}, {r.longitude.toFixed(2)}
              </span>
            </button>
          ))}
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
  scale?: number; // multiply stored value for display; divide input to store
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

  const handleCitySelect = (r: GeoResult) => {
    onChange({
      ...config,
      lat: parseFloat(r.latitude.toFixed(5)),
      lon: parseFloat(r.longitude.toFixed(5)),
      elevation: r.elevation ?? config.elevation,
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
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 5000);
          const res = await fetch(
            `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`,
            { signal: ctrl.signal },
          );
          clearTimeout(timer);
          const json = await res.json();
          const elev = json?.elevation?.[0] ?? config.elevation;
          onChange({ ...config, lat, lon, elevation: Math.round(elev) });
        } catch {
          onChange({ ...config, lat, lon });
        }
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
        <CitySearch onSelect={handleCitySelect} disabled={disabled} />
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
