import { useState } from 'react';
import axios from 'axios';
import FileUpload from './components/FileUpload';
import LaunchConfigForm from './components/LaunchConfig';
import { ComparisonTable } from './components/ComparisonTable';
import { TimeSeriesCharts } from './components/TimeSeriesCharts';
import { TrajectoryPlot } from './components/TrajectoryPlot';
import { TrajectoryMap } from './components/TrajectoryMap';
import { OrientationRender } from './components/OrientationRender';
import { RocketPanel } from './components/RocketPanel';
import { HowToModal } from './components/HowToModal';
import type { LaunchConfig } from './components/LaunchConfig';
import type { UnitSystem, StabilityUnit } from './components/TimeSeriesCharts';
import type { ComparisonResponse } from './types';

const M_FT = 3.28084;

function QuickStat({
  label,
  rpyValue,
  orValue,
  unit,
  decimals = 0,
}: {
  label: string;
  rpyValue: number;
  orValue?: number;
  unit: string;
  decimals?: number;
}) {
  const fmt = (v: number) =>
    v >= 1000
      ? v.toLocaleString('en-US', { maximumFractionDigits: decimals })
      : v.toFixed(decimals);

  const delta = orValue != null ? ((rpyValue - orValue) / orValue) * 100 : null;
  const deltaColor =
    delta === null ? '' :
    Math.abs(delta) <= 5 ? 'text-green-400' :
    Math.abs(delta) <= 15 ? 'text-yellow-400' : 'text-red-400';

  return (
    <div className="bg-gray-800/60 rounded-lg px-3 py-2.5">
      <p className="text-xs text-gray-500 uppercase tracking-wide font-medium mb-0.5">{label}</p>
      <p className="text-lg font-bold text-white tabular-nums leading-tight">
        {fmt(rpyValue)}
        {unit && <span className="text-xs font-normal text-gray-500 ml-1">{unit}</span>}
      </p>
      {orValue != null && (
        <p className="text-xs text-gray-600 mt-0.5">
          OR {fmt(orValue)}
          {delta !== null && (
            <span className={`ml-1 font-semibold ${deltaColor}`}>
              {delta >= 0 ? '+' : ''}{delta.toFixed(1)}%
            </span>
          )}
        </p>
      )}
    </div>
  );
}

function LoadingSpinner() {
  return (
    <div className="flex items-center gap-2.5 bg-gray-900 rounded-xl px-4 py-3">
      <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin shrink-0" />
      <p className="text-gray-400 text-sm">Running simulation… 15–30 s</p>
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="bg-red-950 border border-red-800 rounded-xl px-4 py-3">
      <p className="text-red-400 font-semibold text-sm mb-0.5">Simulation failed</p>
      <p className="text-red-300 text-xs font-mono break-all">{message}</p>
    </div>
  );
}

function EmptyResults() {
  return (
    <div className="flex items-center justify-center h-full min-h-[180px] rounded-xl border border-dashed border-gray-800 text-gray-700 text-sm">
      Results appear here after simulation
    </div>
  );
}

function nowLocalISO() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

const defaultConfig: LaunchConfig = {
  lat: 32.99,
  lon: -106.97,
  elevation: 1400,
  railLength: 5.2,
  inclination: 85,
  heading: 0,
  useLiveWeather: false,
  weatherDateTime: nowLocalISO(),
};

type AppState = 'idle' | 'simulating' | 'results' | 'error';

export default function App() {
  const [appState, setAppState] = useState<AppState>('idle');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [config, setConfig] = useState<LaunchConfig>(defaultConfig);
  const [results, setResults] = useState<ComparisonResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [unitSystem, setUnitSystem] = useState<UnitSystem>('metric');
  const [stabilityUnit, setStabilityUnit] = useState<StabilityUnit>('cal');
  const [panelOpen, setPanelOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  const handleSimulate = async () => {
    if (!selectedFile) return;
    setAppState('simulating');
    setErrorMessage('');
    try {
      const formData = new FormData();
      formData.append('file', selectedFile);
      const params = new URLSearchParams({
        lat: config.lat.toString(),
        lon: config.lon.toString(),
        elevation: config.elevation.toString(),
        rail_length: config.railLength.toString(),
        inclination: config.inclination.toString(),
        heading: config.heading.toString(),
        use_live_weather: config.useLiveWeather.toString(),
        ...(config.useLiveWeather && config.weatherDateTime
          ? { sim_datetime: config.weatherDateTime }
          : {}),
      });
      const response = await axios.post<ComparisonResponse>(
        `/api/simulate?${params}`,
        formData,
        { headers: { 'Content-Type': 'multipart/form-data' } },
      );
      setResults(response.data);
      setAppState('results');
    } catch (err) {
      const msg = axios.isAxiosError(err)
        ? (err.response?.data?.detail ?? err.message)
        : String(err);
      setErrorMessage(msg);
      setAppState('error');
    }
  };

  const isSimulating = appState === 'simulating';
  const rpy = results?.rocketpy_results;
  const or_ = results?.or_results;
  const imp = unitSystem === 'imperial';

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">
      {/* Header */}
      <header className="border-b border-gray-800 px-6 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-bold tracking-tight">RocketBridge</h1>
          <span className="text-gray-700 text-xs hidden sm:inline">OpenRocket → RocketPy</span>
        </div>
        <div className="flex items-center gap-2">
          {results?.rocket_params && (
            <button
              onClick={() => setPanelOpen(true)}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M12 2a10 10 0 110 20A10 10 0 0112 2z" />
              </svg>
              Rocket Details
            </button>
          )}
          <button
            onClick={() => setHelpOpen(true)}
            title="How to use RocketBridge"
            className="flex items-center justify-center w-7 h-7 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-5 space-y-4 w-full flex-1">
        {/* Two-column: input left, results right */}
        <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-5 items-start">

          {/* LEFT — input */}
          <div className="space-y-3">
            <FileUpload
              onFileSelect={setSelectedFile}
              selectedFile={selectedFile}
              disabled={isSimulating}
            />
            <LaunchConfigForm
              config={config}
              onChange={setConfig}
              disabled={isSimulating}
              unitSystem={unitSystem}
            />
            <button
              onClick={handleSimulate}
              disabled={!selectedFile || isSimulating}
              className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold px-6 py-2.5 rounded-xl transition-colors text-sm"
            >
              {isSimulating ? 'Running…' : 'Run Simulation'}
            </button>
            {appState === 'simulating' && <LoadingSpinner />}
            {appState === 'error' && <ErrorBox message={errorMessage} />}
          </div>

          {/* RIGHT — results summary */}
          <div className="space-y-3">
            {appState === 'results' && results && rpy && or_ ? (
              <>
                {/* Controls */}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-gray-600 bg-gray-900 rounded-lg px-2.5 py-1.5 border border-gray-800">
                    {rpy.weather_source === 'standard_atmosphere' ? 'Std Atmosphere' : rpy.weather_source}
                  </span>
                  <div className="flex items-center gap-0.5 bg-gray-900 rounded-lg px-2.5 py-1.5 border border-gray-800">
                    <span className="text-xs text-gray-500 mr-1.5">Units</span>
                    {(['metric', 'imperial'] as UnitSystem[]).map((u) => (
                      <button
                        key={u}
                        onClick={() => setUnitSystem(u)}
                        className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                          unitSystem === u ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
                        }`}
                      >
                        {u === 'metric' ? 'Metric' : 'Imperial'}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-0.5 bg-gray-900 rounded-lg px-2.5 py-1.5 border border-gray-800">
                    <span className="text-xs text-gray-500 mr-1.5">Stability</span>
                    {(['cal', 'pct'] as StabilityUnit[]).map((u) => (
                      <button
                        key={u}
                        onClick={() => setStabilityUnit(u)}
                        className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                          stabilityUnit === u ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
                        }`}
                      >
                        {u === 'cal' ? 'Calibers' : '%'}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Quick stats: 2×2 grid */}
                <div className="grid grid-cols-2 gap-2">
                  <QuickStat
                    label="Apogee"
                    rpyValue={imp ? rpy.apogee_m_agl * M_FT : rpy.apogee_m_agl}
                    orValue={or_.apogee_m_agl != null ? (imp ? or_.apogee_m_agl * M_FT : or_.apogee_m_agl) : undefined}
                    unit={imp ? 'ft AGL' : 'm AGL'}
                    decimals={0}
                  />
                  <QuickStat
                    label="Max Velocity"
                    rpyValue={imp ? rpy.max_speed_ms * M_FT : rpy.max_speed_ms}
                    orValue={or_.max_velocity_ms != null ? (imp ? or_.max_velocity_ms * M_FT : or_.max_velocity_ms) : undefined}
                    unit={imp ? 'ft/s' : 'm/s'}
                    decimals={1}
                  />
                  <QuickStat
                    label="Max Mach"
                    rpyValue={rpy.max_mach}
                    orValue={or_.max_mach}
                    unit=""
                    decimals={2}
                  />
                  <QuickStat
                    label="Time to Apogee"
                    rpyValue={rpy.apogee_time_s}
                    orValue={or_.time_to_apogee_s}
                    unit="s"
                    decimals={1}
                  />
                </div>

                <ComparisonTable
                  orResults={or_}
                  rocketPyResults={rpy}
                  unitSystem={unitSystem}
                  stabilityUnit={stabilityUnit}
                />
              </>
            ) : (
              appState !== 'simulating' && <EmptyResults />
            )}
          </div>
        </div>

        {/* Full-width: charts + 3D (only when results) */}
        {appState === 'results' && results && rpy && or_ && (
          <>
            <TimeSeriesCharts
              orTimeseries={or_.timeseries}
              rocketPyTimeseries={rpy.timeseries}
              burnOutTimeS={rpy.burn_out_time_s}
              unitSystem={unitSystem}
              stabilityUnit={stabilityUnit}
            />
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <TrajectoryPlot
                trajectory={rpy.trajectory_3d}
                apogeeAgl={rpy.apogee_m_agl}
                apogeeTimeS={rpy.apogee_time_s}
                burnOutTimeS={rpy.burn_out_time_s}
                unitSystem={unitSystem}
              />
              <OrientationRender
                trajectory={rpy.trajectory_3d}
                burnOutTimeS={rpy.burn_out_time_s}
                apogeeTimeS={rpy.apogee_time_s}
              />
            </div>
            <TrajectoryMap
              trajectory={rpy.trajectory_3d}
              launchLat={rpy.launch_lat}
              launchLon={rpy.launch_lon}
              launchElevationM={rpy.launch_elevation_m}
              apogeeTimeS={rpy.apogee_time_s}
              burnOutTimeS={rpy.burn_out_time_s}
              kmlData={results.kml_data}
            />
          </>
        )}
      </main>

      {results?.rocket_params && (
        <RocketPanel
          params={results.rocket_params}
          diagram={results.rocket_diagram}
          weatherSource={rpy?.weather_source}
          unitSystem={unitSystem}
          isOpen={panelOpen}
          onClose={() => setPanelOpen(false)}
        />
      )}
      <HowToModal isOpen={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}
