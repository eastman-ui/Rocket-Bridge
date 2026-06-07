// Rocket-Bridge/frontend/src/tools/DragTimeTool.tsx
import { useState } from 'react';
import PlotlyImport from 'react-plotly.js';
const Plot = (PlotlyImport as any).default ?? PlotlyImport;
import type { ComparisonResponse } from '../types';
import type { LaunchConfig } from '../components/LaunchConfig';
import type { UnitSystem } from '../components/TimeSeriesCharts';

interface RasAeroResult {
  burn_out_time_s: number;
  timeseries: { time: number[]; drag_coeff: number[] };
}

function trimToBurnout<T extends { time: number[]; drag_coeff: number[] }>(
  ts: T,
  burnout: number,
): { time: number[]; drag_coeff: number[] } {
  let end = ts.time.length;
  for (let i = 0; i < ts.time.length; i++) {
    if (ts.time[i] > burnout) { end = i; break; }
  }
  return {
    time: ts.time.slice(0, end),
    drag_coeff: ts.drag_coeff.slice(0, end),
  };
}

interface Props {
  selectedFile: File | null;
  cachedResult: ComparisonResponse | null;
  config: LaunchConfig;
  unitSystem: UnitSystem;
}

export function DragTimeTool({ selectedFile, cachedResult, config }: Props) {
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

  const burnout =
    result?.burn_out_time_s ??
    cachedResult?.rocketpy_results?.burn_out_time_s ??
    Infinity;

  const traces: any[] = [];

  if (cachedResult?.or_results?.timeseries?.drag_coeff?.length) {
    const ts = trimToBurnout(
      cachedResult.or_results.timeseries as { time: number[]; drag_coeff: number[] },
      burnout,
    );
    traces.push({
      x: ts.time, y: ts.drag_coeff,
      name: 'OpenRocket', type: 'scatter', mode: 'lines',
      line: { color: '#f59e0b', width: 1.5 },
    });
  }

  if (cachedResult?.rocketpy_results?.timeseries?.drag_coeff?.length) {
    const ts = trimToBurnout(
      cachedResult.rocketpy_results.timeseries as { time: number[]; drag_coeff: number[] },
      burnout,
    );
    traces.push({
      x: ts.time, y: ts.drag_coeff,
      name: 'RocketPy (OR drag)', type: 'scatter', mode: 'lines',
      line: { color: '#60a5fa', width: 1.5 },
    });
  }

  if (result?.timeseries?.drag_coeff?.length) {
    const ts = trimToBurnout(result.timeseries, result.burn_out_time_s);
    traces.push({
      x: ts.time, y: ts.drag_coeff,
      name: 'RocketPy (RasAero drag)', type: 'scatter', mode: 'lines',
      line: { color: '#34d399', width: 2 },
    });
  }

  const plotLayout: any = {
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: '#9ca3af', size: 11 },
    xaxis: { title: 'Time (s)', gridcolor: '#1f2937', zerolinecolor: '#374151' },
    yaxis: { title: 'CD', gridcolor: '#1f2937', zerolinecolor: '#374151' },
    legend: { bgcolor: 'transparent', font: { size: 10 } },
    margin: { l: 50, r: 20, t: 20, b: 50 },
    height: 300,
  };

  const plotConfig = { displayModeBar: 'hover' as const, scrollZoom: true, responsive: true };

  const noOrkLoaded = !selectedFile;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-200 mb-1">Drag vs Time</h3>
        <p className="text-xs text-gray-500">
          Compare drag coefficient (CD) over powered flight for OpenRocket, RocketPy (OR drag), and RocketPy (RasAero drag).
        </p>
      </div>

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
            <p className="text-gray-600 text-xs">Optional — adds RasAero series</p>
          </div>
        )}
      </div>

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

      {error && (
        <div className="bg-red-950 border border-red-800 rounded-xl px-4 py-3">
          <p className="text-red-400 font-semibold text-sm mb-0.5">Simulation failed</p>
          <p className="text-red-300 text-xs font-mono break-all">{error}</p>
        </div>
      )}

      {!cachedResult && (
        <p className="text-xs text-gray-500 italic">
          Run a simulation on the main page to add OR and RocketPy (OR drag) series.
        </p>
      )}

      {traces.length > 0 && (
        <div>
          <p className="text-xs text-gray-400 uppercase tracking-wide font-semibold mb-2">CD vs Time (powered flight)</p>
          <Plot
            data={traces}
            layout={plotLayout}
            config={plotConfig}
            style={{ width: '100%' }}
          />
        </div>
      )}
    </div>
  );
}
