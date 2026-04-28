import { useState, useEffect } from 'react';
import FileUpload from './components/FileUpload';
import LaunchConfigForm from './components/LaunchConfig';
import { ComparisonTable } from './components/ComparisonTable';
import { TimeSeriesCharts } from './components/TimeSeriesCharts';
import { TrajectoryPlot } from './components/TrajectoryPlot';
import { TrajectoryMap } from './components/TrajectoryMap';
import { OrientationRender } from './components/OrientationRender';
import { RocketPanel } from './components/RocketPanel';
import { HowToModal } from './components/HowToModal';
import { WeatherPanel } from './components/WeatherPanel';
import { ToolsPage } from './pages/ToolsPage';
import type { WeatherData } from './components/WeatherPanel';
import type { LaunchConfig } from './components/LaunchConfig';
import type { UnitSystem, StabilityUnit } from './components/TimeSeriesCharts';
import type { ComparisonResponse } from './types';

type ActivePage = 'main' | 'tools';


const SIM_STAGE_LABELS: Record<string, string> = {
  validating: 'Validating file…',
  converting: 'Converting .ork to RocketPy…',
  simulating: 'Running simulations…',
  building: 'Building results…',
  done: 'Complete',
};

function SimProgress({ stage, pct }: { stage: string; pct: number }) {
  return (
    <div className="bg-gray-900 rounded-xl px-4 py-3 space-y-2">
      <div className="flex items-center gap-2.5">
        <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin shrink-0" />
        <p className="text-gray-400 text-sm">{SIM_STAGE_LABELS[stage] ?? stage}</p>
      </div>
      <div className="w-full bg-gray-800 rounded-full h-1">
        <div
          className="bg-blue-500 h-1 rounded-full transition-all duration-700 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
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

export function nowRoundedLocalISO() {
  const d = new Date();
  if (d.getMinutes() >= 30) {
    d.setHours(d.getHours() + 1, 0, 0, 0);
  } else {
    d.setMinutes(0, 0, 0);
  }
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
  weatherDateTime: nowRoundedLocalISO(),
};

// ─── Result cache (localStorage) ─────────────────────────────────────────────
const CACHE_KEY = 'rocketbridge_last_result';

interface CacheMeta { filename: string; timestamp: number; config: LaunchConfig; }
interface CacheEntry extends CacheMeta { results: ComparisonResponse; }

function saveCache(results: ComparisonResponse, config: LaunchConfig, filename: string) {
  try {
    const entry: CacheEntry = { results, config, filename, timestamp: Date.now() };
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch { /* quota exceeded — silently skip */ }
}

function loadCache(): CacheEntry | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as CacheEntry) : null;
  } catch { return null; }
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function CachedBanner({ meta, stale, onClear }: { meta: CacheMeta; stale: boolean; onClear: () => void }) {
  return (
    <div className="flex items-center gap-2 bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-xs text-gray-400">
      <svg className="w-3.5 h-3.5 text-gray-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 7v10c0 1.1.9 2 2 2h12a2 2 0 002-2V9l-5-5H6a2 2 0 00-2 2z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M14 2v5h5" />
      </svg>
      <span className="truncate">Cached · <span className="text-gray-300">{meta.filename}</span> · {timeAgo(meta.timestamp)}</span>
      {stale && <span className="text-amber-400 font-medium shrink-0">Results may be outdated</span>}
      <button onClick={onClear} className="ml-auto shrink-0 text-gray-600 hover:text-gray-300 transition-colors">Clear</button>
    </div>
  );
}

type AppState = 'idle' | 'simulating' | 'results' | 'error';

export default function App() {
  const [appState, setAppState] = useState<AppState>('idle');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [config, setConfig] = useState<LaunchConfig>(defaultConfig);
  const [results, setResults] = useState<ComparisonResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [simStage, setSimStage] = useState('');
  const [simPct, setSimPct] = useState(0);
  const [unitSystem, setUnitSystem] = useState<UnitSystem>('imperial');
  const [stabilityUnit, setStabilityUnit] = useState<StabilityUnit>('cal');
  const [panelOpen, setPanelOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [weatherData, setWeatherData] = useState<WeatherData | null>(null);
  const [orRailLengthM, setOrRailLengthM] = useState<number | null>(null);
  const [cacheMeta, setCacheMeta] = useState<CacheMeta | null>(null);
  const [resultsStale, setResultsStale] = useState(false);
  const [activePage, setActivePage] = useState<ActivePage>('main');

  useEffect(() => {
    const entry = loadCache();
    if (!entry) return;
    setResults(entry.results);
    setConfig({ ...entry.config, weatherDateTime: nowRoundedLocalISO() });
    const orRailLen = entry.results.or_results?.or_launch_rod_length_m ?? null;
    setOrRailLengthM(orRailLen);
    setAppState('results');
    setCacheMeta({ filename: entry.filename, timestamp: entry.timestamp, config: entry.config });
    setResultsStale(Date.now() - entry.timestamp > 30 * 60_000);
  }, []);

  const handleSimulate = async () => {
    if (!selectedFile) return;
    setAppState('simulating');
    setSimStage('validating');
    setSimPct(5);
    setErrorMessage('');
    setCacheMeta(null);
    setResultsStale(false);
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

      const response = await fetch(`/api/simulate?${params}`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({ detail: response.statusText }));
        throw new Error(body.detail ?? response.statusText);
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          for (const line of part.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            let event: Record<string, unknown>;
            try { event = JSON.parse(line.slice(6)); } catch { continue; }
            const stage = event.stage as string;
            const pct = event.pct as number;
            if (stage === 'error') throw new Error((event.message as string) ?? 'Simulation failed');
            setSimStage(stage);
            setSimPct(pct);
            if (stage === 'done') {
              const data = event.result as ComparisonResponse;
              const orRailLen = data.or_results?.or_launch_rod_length_m ?? null;
              setOrRailLengthM(orRailLen);
              if (orRailLen != null) setConfig(prev => ({ ...prev, railLength: orRailLen }));
              setResults(data);
              setAppState('results');
              saveCache(data, config, selectedFile.name);
              setCacheMeta({ filename: selectedFile.name, timestamp: Date.now(), config });
            }
          }
        }
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
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
          {/* Page nav */}
          <div className="flex items-center gap-0.5 bg-gray-900 rounded-lg px-1 py-1 border border-gray-800 ml-2">
            {(['main', 'tools'] as ActivePage[]).map((p) => (
              <button
                key={p}
                onClick={() => setActivePage(p)}
                className={`px-3 py-0.5 rounded text-xs font-medium transition-colors ${
                  activePage === p ? 'bg-blue-600 text-white' : 'text-gray-500 hover:text-white'
                }`}
              >
                {p === 'main' ? 'Simulation' : 'Tools'}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Units toggle — always visible so weather panel reflects it */}
          <div className="flex items-center gap-0.5 bg-gray-900 rounded-lg px-2 py-1 border border-gray-800">
            {(['metric', 'imperial'] as UnitSystem[]).map((u) => (
              <button
                key={u}
                onClick={() => setUnitSystem(u)}
                className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                  unitSystem === u ? 'bg-blue-600 text-white' : 'text-gray-500 hover:text-white'
                }`}
              >
                {u === 'metric' ? 'Metric' : 'Imperial'}
              </button>
            ))}
          </div>
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

      <div className={activePage !== 'tools' ? 'hidden' : ''}>
        <ToolsPage cachedResult={results} config={config} unitSystem={unitSystem} selectedFile={selectedFile} />
      </div>

      <main className={`max-w-7xl mx-auto px-6 py-5 space-y-4 w-full flex-1 ${activePage !== 'main' ? 'hidden' : ''}`}>
        {/* Two-column: input left, results right */}
        <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-5 lg:items-stretch">

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
              orRailLengthM={orRailLengthM ?? undefined}
            />
            <button
              onClick={handleSimulate}
              disabled={!selectedFile || isSimulating}
              className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold px-6 py-2.5 rounded-xl transition-colors text-sm"
            >
              {isSimulating ? 'Running…' : 'Run Simulation'}
            </button>
            {appState === 'simulating' && <SimProgress stage={simStage} pct={simPct} />}
            {appState === 'error' && <ErrorBox message={errorMessage} />}
          </div>

          {/* RIGHT — results summary */}
          <div className="flex flex-col gap-3">
            {appState === 'results' && results && rpy && or_ ? (
              <>
                {cacheMeta && (
                  <CachedBanner
                    meta={cacheMeta}
                    stale={resultsStale}
                    onClear={() => {
                      localStorage.removeItem(CACHE_KEY);
                      setCacheMeta(null);
                      setResults(null);
                      setAppState('idle');
                    }}
                  />
                )}
                {/* Controls */}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-gray-600 bg-gray-900 rounded-lg px-2.5 py-1.5 border border-gray-800">
                    {rpy.weather_source === 'standard_atmosphere' ? 'Std Atmosphere' : rpy.weather_source}
                  </span>
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

                {/* Unsupported config warnings */}
                {results.warnings && results.warnings.length > 0 && (
                  <div className="bg-yellow-950 border border-yellow-700 rounded-xl p-3 space-y-1">
                    <p className="text-xs text-yellow-400 uppercase tracking-wide font-semibold">Configuration Warnings</p>
                    {results.warnings.map((w, i) => (
                      <p key={i} className="text-xs text-yellow-300">{w}</p>
                    ))}
                  </div>
                )}

                {/* Rocket diagram */}
                {results.rocket_diagram && (
                  <div className="bg-gray-900 rounded-xl p-3">
                    <p className="text-xs text-gray-600 uppercase tracking-wide font-medium mb-2">Rocket Profile</p>
                    <img
                      src={`data:image/png;base64,${results.rocket_diagram}`}
                      alt="Rocket cross-section diagram"
                      className="w-full rounded"
                    />
                  </div>
                )}

                <ComparisonTable
                  orResults={or_}
                  rocketPyResults={rpy}
                  unitSystem={unitSystem}
                  stabilityUnit={stabilityUnit}
                  className="flex-1"
                />
              </>
            ) : (
              appState !== 'simulating' && <EmptyResults />
            )}
          </div>
        </div>

        {/* Full-width: weather panel (always shown when lat/lon set) */}
        <WeatherPanel
          lat={config.lat}
          lon={config.lon}
          elevationM={config.elevation}
          launchDateTime={config.weatherDateTime}
          unitSystem={unitSystem}
          onWeatherData={setWeatherData}
        />

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
              weatherData={weatherData ?? undefined}
              weatherIsImperial={imp}
              launchDateTime={config.weatherDateTime}
              hourlyLandings={results.hourly_landings}
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
