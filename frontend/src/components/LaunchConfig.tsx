export interface LaunchConfig {
  lat: number;
  lon: number;
  elevation: number;
  railLength: number;
  inclination: number;
  heading: number;
  useLiveWeather: boolean;
}

interface LaunchConfigProps {
  config: LaunchConfig;
  onChange: (config: LaunchConfig) => void;
  disabled: boolean;
}

function Field({
  label,
  unit,
  value,
  field,
  config,
  onChange,
  disabled,
  step,
}: {
  label: string;
  unit?: string;
  value: number;
  field: keyof LaunchConfig;
  config: LaunchConfig;
  onChange: (config: LaunchConfig) => void;
  disabled: boolean;
  step?: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm text-gray-400">
        {label}
        {unit && <span className="ml-1 text-gray-500">{unit}</span>}
      </label>
      <input
        type="number"
        value={value}
        step={step ?? 1}
        disabled={disabled}
        onChange={(e) =>
          onChange({ ...config, [field]: parseFloat(e.target.value) })
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
}: LaunchConfigProps) {
  return (
    <div className="bg-gray-900 rounded-xl p-5 space-y-4">
      <h2 className="text-lg font-semibold text-white">Launch Configuration</h2>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
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
          unit="m"
          value={config.elevation}
          field="elevation"
          config={config}
          onChange={onChange}
          disabled={disabled}
          step={1}
        />
        <Field
          label="Rail Length"
          unit="m"
          value={config.railLength}
          field="railLength"
          config={config}
          onChange={onChange}
          disabled={disabled}
          step={0.1}
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
        <div>
          <label
            htmlFor="live-weather"
            className="text-sm text-gray-300 cursor-pointer select-none"
          >
            Use live weather (GFS)
          </label>
          {config.useLiveWeather && (
            <p className="text-xs text-yellow-400 mt-0.5">
              ⚠ GFS requires internet and adds ~30s
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
