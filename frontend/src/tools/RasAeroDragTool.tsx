// Rocket-Bridge/frontend/src/tools/RasAeroDragTool.tsx
import { useState } from 'react';
import PlotlyImport from 'react-plotly.js';
const Plot = (PlotlyImport as any).default ?? PlotlyImport;
import type { ComparisonResponse } from '../types';
import type { LaunchConfig } from '../components/LaunchConfig';
import type { UnitSystem } from '../components/TimeSeriesCharts';

interface RasAeroResult {
  apogee_m_agl: number;
  max_speed_ms: number;
  max_mach: number;
  max_acceleration_ms2: number;
  impact_velocity_ms: number;
  out_of_rail_velocity: number;
  static_margin_cal: number;
  timeseries: { time: number[]; mach: number[]; stability: number[] };
}

interface Props {
  selectedFile: File | null;
  cachedResult: ComparisonResponse | null;
  config: LaunchConfig;
  unitSystem: UnitSystem;
}

const M_FT = 3.28084;

export function RasAeroDragTool({ selectedFile, cachedResult, config, unitSystem }: Props) {
  const imp = unitSystem === 'imperial';
  const [dragCsvFile, setDragCsvFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RasAeroResult | null>(null);
  const [error, setError] = useState<string>('');

  const acceptCsv = (f: File | undefined) => {
    if (f?.name.toLowerCase().endsWith('.csv')) setDragCsvFile(f);
  };

  const handleRun = async () => {
    if (!selectedFile || !dragCsvFile) return;
    setRunning(true);
    setError('');
    setResult(null);
    try {
      const fd = new FormData();
      fd.append('file', selectedFile);
      fd.append('drag_csv', dragCsvFile);
      const params = new URLSearchParams({
        lat: config.lat.toString(),
        lon: config.lon.toString(),
        elevation: config.elevation.toString(),
        rail_length: config.railLength.toString(),
        inclination: config.inclination.toString(),
        heading: config.heading.toString(),
      });
      const res = await fetch(`/api/simulate-rasaero?${params}`, {
        method: 'POST',
        body: fd,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(body.detail ?? res.statusText);
      }
      setResult(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  // ── Stability vs Time chart data ──────────────────────────────────────────
  const stabTimeTraces: any[] = [];
  if (cachedResult?.or_results?.timeseries) {
    const ts = cachedResult.or_results.timeseries;
    stabTimeTraces.push({
      x: ts.time, y: ts.stability,
      name: 'OpenRocket', type: 'scatter', mode: 'lines',
      line: { color: '#f59e0b', width: 1.5 },
    });
  }
  if (cachedResult?.rocketpy_results?.timeseries) {
    const ts = cachedResult.rocketpy_results.timeseries;
    stabTimeTraces.push({
      x: ts.time, y: ts.stability,
      name: 'RocketPy (OR drag)', type: 'scatter', mode: 'lines',
      line: { color: '#60a5fa', width: 1.5 },
    });
  }
  if (result) {
    stabTimeTraces.push({
      x: result.timeseries.time, y: result.timeseries.stability,
      name: 'RocketPy (RasAero drag)', type: 'scatter', mode: 'lines',
      line: { color: '#34d399', width: 2 },
    });
  }

  // ── Stability vs Mach chart data ──────────────────────────────────────────
  const stabMachTraces: any[] = [];
  if (cachedResult?.or_results?.timeseries) {
    const ts = cachedResult.or_results.timeseries;
    stabMachTraces.push({
      x: ts.mach, y: ts.stability,
      name: 'OpenRocket', type: 'scatter', mode: 'lines',
      line: { color: '#f59e0b', width: 1.5 },
    });
  }
  if (cachedResult?.rocketpy_results?.timeseries) {
    const ts = cachedResult.rocketpy_results.timeseries;
    stabMachTraces.push({
      x: ts.mach, y: ts.stability,
      name: 'RocketPy (OR drag)', type: 'scatter', mode: 'lines',
      line: { color: '#60a5fa', width: 1.5 },
    });
  }
  if (result) {
    stabMachTraces.push({
      x: result.timeseries.mach, y: result.timeseries.stability,
      name: 'RocketPy (RasAero drag)', type: 'scatter', mode: 'lines',
      line: { color: '#34d399', width: 2 },
    });
  }

  const plotLayout = (xTitle: string): any => ({
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: '#9ca3af', size: 11 },
    xaxis: { title: xTitle, gridcolor: '#1f2937', zerolinecolor: '#374151' },
    yaxis: { title: 'Stability (cal)', gridcolor: '#1f2937', zerolinecolor: '#374151' },
    legend: { bgcolor: 'transparent', font: { size: 10 } },
    margin: { l: 50, r: 20, t: 20, b: 50 },
    height: 280,
  });

  const plotConfig = { displayModeBar: false, responsive: true };

  const noOrkLoaded = !selectedFile;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-200 mb-1">RasAero Drag Override</h3>
        <p className="text-xs text-gray-500">
          Upload a RasAero CD export CSV to run RocketPy with that drag curve and compare stability with the standard results.
        </p>
      </div>

      {/* .ork warning */}
      {noOrkLoaded && (
        <p className="text-xs text-amber-400 bg-amber-950/30 border border-amber-800/40 rounded-lg px-3 py-2">
          Load a .ork file on the Simulation page first.
        </p>
      )}

      {/* CSV upload zone */}
      <div
        className={[
          'relative rounded-xl border-2 border-dashed px-4 py-5 flex flex-col items-center justify-center text-center transition-colors',
          isDragging ? 'border-blue-400 bg-blue-950/30'
            : dragCsvFile ? 'border-green-600 bg-gray-900'
            : 'border-gray-600 bg-gray-900',
        ].join(' ')}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => { e.preventDefault(); setIsDragging(false); acceptCsv(e.dataTransfer.files[0]); }}
      >
        <input
          type="file"
          accept=".csv"
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          onChange={(e) => { acceptCsv(e.target.files?.[0]); e.target.value = ''; }}
        />
        {dragCsvFile ? (
          <div className="pointer-events-none space-y-1">
            <p className="text-green-400 font-semibold text-sm">CSV loaded</p>
            <p className="text-white text-sm font-medium truncate max-w-[260px]">{dragCsvFile.name}</p>
            <p className="text-gray-500 text-xs">{(dragCsvFile.size / 1024).toFixed(1)} KB</p>
          </div>
        ) : (
          <div className="pointer-events-none space-y-1">
            <p className="text-gray-300 text-sm font-medium">
              {isDragging ? 'Drop here\u2026' : 'Drop RasAero CSV or click'}
            </p>
            <p className="text-gray-600 text-xs">RasAero CD export (.csv)</p>
          </div>
        )}
      </div>

      {/* Run button */}
      <button
        onClick={handleRun}
        disabled={noOrkLoaded || !dragCsvFile || running}
        className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold px-6 py-2.5 rounded-xl transition-colors text-sm"
      >
        {running ? (
          <span className="flex items-center justify-center gap-2">
            <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
            Running\u2026
          </span>
        ) : 'Run with RasAero Drag'}
      </button>

      {/* Error */}
      {error && (
        <div className="bg-red-950 border border-red-800 rounded-xl px-4 py-3">
          <p className="text-red-400 font-semibold text-sm mb-0.5">Simulation failed</p>
          <p className="text-red-300 text-xs font-mono break-all">{error}</p>
        </div>
      )}

      {/* Scalar results */}
      {result && (
        <div className="bg-gray-800/50 rounded-xl border border-gray-700 p-4">
          <p className="text-xs text-gray-400 uppercase tracking-wide font-semibold mb-3">
            RocketPy \u2014 RasAero Drag
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {[
              { label: 'Apogee', value: imp ? `${Math.round(result.apogee_m_agl * M_FT).toLocaleString()} ft` : `${Math.round(result.apogee_m_agl).toLocaleString()} m` },
              { label: 'Max Velocity', value: imp ? `${(result.max_speed_ms * M_FT).toFixed(0)} ft/s` : `${result.max_speed_ms.toFixed(1)} m/s` },
              { label: 'Max Mach', value: result.max_mach.toFixed(3) },
              { label: 'Max Accel', value: imp ? `${(result.max_acceleration_ms2 / 9.81).toFixed(1)} G` : `${result.max_acceleration_ms2.toFixed(1)} m/s\u00b2` },
              { label: 'Off Rail', value: imp ? `${(result.out_of_rail_velocity * M_FT).toFixed(0)} ft/s` : `${result.out_of_rail_velocity.toFixed(1)} m/s` },
              { label: 'Stability', value: `${result.static_margin_cal.toFixed(2)} cal` },
            ].map(({ label, value }) => (
              <div key={label} className="bg-gray-900 rounded-lg px-3 py-2">
                <p className="text-[10px] text-gray-500 uppercase tracking-wide">{label}</p>
                <p className="text-sm font-semibold text-gray-100 mt-0.5">{value}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Charts — shown as soon as any traces exist */}
      {stabTimeTraces.length > 0 && (
        <div className="space-y-4">
          {!cachedResult && (
            <p className="text-xs text-gray-500 italic">
              Run a simulation on the main page to add OR and RocketPy (OR drag) comparison series.
            </p>
          )}
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wide font-semibold mb-2">Stability vs Time</p>
            <Plot
              data={stabTimeTraces}
              layout={plotLayout('Time (s)')}
              config={plotConfig}
              style={{ width: '100%' }}
            />
          </div>
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wide font-semibold mb-2">Stability vs Mach</p>
            <Plot
              data={stabMachTraces}
              layout={plotLayout('Mach')}
              config={plotConfig}
              style={{ width: '100%' }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
