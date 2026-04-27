import { useState } from 'react';
import type { UnitSystem } from './TimeSeriesCharts';

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
}: LaunchConfigProps) {
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState<string | null>(null);
  const imp = unitSystem === 'imperial';

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
          const res = await fetch(
            `https://api.open-elevation.com/api/v1/lookup?locations=${lat},${lon}`,
          );
          const json = await res.json();
          const elev = json?.results?.[0]?.elevation ?? config.elevation;
          onChange({ ...config, lat, lon, elevation: elev });
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
          className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {locating ? 'Locating...' : 'Use my location'}
        </button>
      </div>
      {locError && (
        <p className="text-xs text-red-400">{locError}</p>
      )}

      <div className="grid grid-cols-2 gap-3">
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
        <Field
          label="Rail Length"
          unit={imp ? 'ft' : 'm'}
          value={config.railLength}
          field="railLength"
          config={config}
          onChange={onChange}
          disabled={disabled}
          step={imp ? 0.5 : 0.1}
          scale={imp ? M_FT : 1}
        />
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
          onChange={(e) => onChange({ ...config, useLiveWeather: e.target.checked })}
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
