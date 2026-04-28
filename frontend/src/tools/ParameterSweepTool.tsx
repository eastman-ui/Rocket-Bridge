import { useState, useRef } from 'react';
import PlotlyImport from 'react-plotly.js';
const Plot = (PlotlyImport as any).default ?? PlotlyImport;
import type { ComparisonResponse } from '../types';
import type { LaunchConfig } from '../components/LaunchConfig';
import type { UnitSystem } from '../components/TimeSeriesCharts';

interface Props {
  result: ComparisonResponse;
  config: LaunchConfig;
  unitSystem: UnitSystem;
}

type SweepParam = 'inclination' | 'rail_length' | 'heading' | 'elevation';

const PARAM_DEFS: Record<SweepParam, { label: string; unit: string; defaultMin: number; defaultMax: number }> = {
  inclination: { label: 'Inclination', unit: '°', defaultMin: 70, defaultMax: 89 },
  rail_length:  { label: 'Rail Length', unit: 'm', defaultMin: 2, defaultMax: 8 },
  heading:      { label: 'Heading', unit: '°', defaultMin: 0, defaultMax: 360 },
  elevation:    { label: 'Elevation', unit: 'm', defaultMin: 0, defaultMax: 3000 },
};

interface SweepPoint {
  param_value: number;
  apogee_m_agl?: number;
  max_speed_ms?: number;
  stability_cal?: number;
  off_rail_velocity?: number;
  error?: string;
}

const M_FT = 3.28084;

export function ParameterSweepTool({ result, config, unitSystem }: Props) {
  const imp = unitSystem === 'imperial';
  const [param, setParam] = useState<SweepParam>('inclination');
  const [sweepMin, setSweepMin] = useState(PARAM_DEFS.inclination.defaultMin);
  const [sweepMax, setSweepMax] = useState(PARAM_DEFS.inclination.defaultMax);
  const [steps, setSteps] = useState(10);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [sweepData, setSweepData] = useState<SweepPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [orkFile, setOrkFile] = useState<File | null>(null);

  const def = PARAM_DEFS[param];

  const handleParamChange = (p: SweepParam) => {
    setParam(p);
    setSweepMin(PARAM_DEFS[p].defaultMin);
    setSweepMax(PARAM_DEFS[p].defaultMax);
    setSweepData(null);
  };

  const handleRun = async () => {
    if (!orkFile) { setError('Re-select your .ork file to run sweep'); return; }
    setRunning(true);
    setError(null);
    setSweepData(null);
    setProgress(0);
    try {
      const formData = new FormData();
      formData.append('file', orkFile);
      const params = new URLSearchParams({
        lat: config.lat.toString(),
        lon: config.lon.toString(),
        elevation: config.elevation.toString(),
        rail_length: config.railLength.toString(),
        inclination: config.inclination.toString(),
        heading: config.heading.toString(),
        sweep_param: param,
        sweep_min: sweepMin.toString(),
        sweep_max: sweepMax.toString(),
        sweep_steps: steps.toString(),
      });
      const response = await fetch(`/api/sweep?${params}`, { method: 'POST', body: formData });
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
            let ev: Record<string, any>;
            try { ev = JSON.parse(line.slice(6)); } catch { continue; }
            if (ev.stage === 'error') throw new Error(ev.message);
            if (ev.stage === 'simulating' && ev.total) setProgress(Math.round((ev.done ?? 0) / ev.total * 100));
            if (ev.stage === 'done') setSweepData(ev.results as SweepPoint[]);
          }
        }
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  const fmtAlt = (m: number) => imp ? Math.round(m * M_FT) : Math.round(m);
  const altUnit = imp ? 'ft' : 'm';

  const valid = sweepData?.filter(p => !p.error) ?? [];
  const xVals = valid.map(p => p.param_value);
  const apogeeVals = valid.map(p => fmtAlt(p.apogee_m_agl ?? 0));
  const stabVals = valid.map(p => p.stability_cal ?? 0);
  const currentVal = config[param === 'rail_length' ? 'railLength' : param] as number;

  const layout: any = {
    paper_bgcolor: '#111827', plot_bgcolor: '#1f2937',
    margin: { t: 10, r: 60, b: 45, l: 60 },
    height: 280, autosize: true,
    xaxis: {
      title: { text: `${def.label} (${def.unit})`, font: { color: '#9ca3af', size: 10 } },
      gridcolor: '#374151', color: '#6b7280', tickfont: { size: 9 },
    },
    yaxis: {
      title: { text: `Apogee AGL (${altUnit})`, font: { color: '#60a5fa', size: 10 } },
      gridcolor: '#374151', color: '#6b7280', tickfont: { size: 9 }, tickfont_color: '#60a5fa',
    },
    yaxis2: {
      title: { text: 'Stability (cal)', font: { color: '#34d399', size: 10 } },
      overlaying: 'y', side: 'right', color: '#6b7280', tickfont: { size: 9 },
    },
    legend: { font: { color: '#9ca3af', size: 9 }, bgcolor: 'transparent' },
    shapes: currentVal != null ? [{
      type: 'line', x0: currentVal, x1: currentVal, y0: 0, y1: 1,
      yref: 'paper', line: { color: '#9ca3af', width: 1, dash: 'dot' },
    }] : [],
  };

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-gray-200 uppercase tracking-wide">Parameter Sweep</h3>

      {/* File selector */}
      <div className="flex items-center gap-3 text-xs">
        <input ref={fileInputRef} type="file" accept=".ork" className="hidden"
          onChange={e => setOrkFile(e.target.files?.[0] ?? null)} />
        <button onClick={() => fileInputRef.current?.click()}
          className="bg-gray-800 hover:bg-gray-700 text-gray-300 px-3 py-1.5 rounded-lg transition-colors border border-gray-700">
          {orkFile ? `📄 ${orkFile.name}` : 'Select .ork file'}
        </button>
        <span className="text-gray-600">Same file used in main simulation</span>
      </div>

      {/* Controls */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <div className="flex flex-col gap-1">
          <label className="text-gray-400">Parameter</label>
          <select value={param} onChange={e => handleParamChange(e.target.value as SweepParam)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs">
            {(Object.keys(PARAM_DEFS) as SweepParam[]).map(k => (
              <option key={k} value={k}>{PARAM_DEFS[k].label}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-gray-400">Min <span className="text-gray-600">{def.unit}</span></label>
          <input type="number" value={sweepMin} onChange={e => setSweepMin(Number(e.target.value))}
            className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-gray-400">Max <span className="text-gray-600">{def.unit}</span></label>
          <input type="number" value={sweepMax} onChange={e => setSweepMax(Number(e.target.value))}
            className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-gray-400">Steps <span className="text-gray-600">max 20</span></label>
          <input type="number" min={2} max={20} value={steps} onChange={e => setSteps(Number(e.target.value))}
            className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs" />
        </div>
      </div>

      <button onClick={handleRun} disabled={running || !orkFile}
        className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold px-4 py-2 rounded-lg transition-colors text-sm">
        {running ? `Running… ${progress}%` : 'Run Sweep'}
      </button>

      {running && (
        <div className="w-full bg-gray-800 rounded-full h-1.5">
          <div className="bg-blue-500 h-1.5 rounded-full transition-all duration-500" style={{ width: `${progress}%` }} />
        </div>
      )}

      {error && <p className="text-xs text-red-400 bg-red-950/40 border border-red-800 rounded-lg px-3 py-2">{error}</p>}

      {valid.length > 0 && (
        <>
          <Plot
            data={[
              { x: xVals, y: apogeeVals, type: 'scatter', mode: 'lines+markers', name: `Apogee (${altUnit})`, line: { color: '#60a5fa', width: 2 }, marker: { size: 6 } },
              { x: xVals, y: stabVals, type: 'scatter', mode: 'lines+markers', name: 'Stability (cal)', yaxis: 'y2', line: { color: '#34d399', width: 2, dash: 'dash' }, marker: { size: 5 } },
            ]}
            layout={layout}
            config={{ responsive: true, displayModeBar: false }}
            style={{ width: '100%' }}
            useResizeHandler
          />
          <p className="text-xs text-gray-600">Dotted vertical line = current config value</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-700">
                  <th className="text-left py-1 pr-4">{def.label} ({def.unit})</th>
                  <th className="text-right py-1 px-3">Apogee ({altUnit})</th>
                  <th className="text-right py-1 px-3">Max Vel ({imp ? 'ft/s' : 'm/s'})</th>
                  <th className="text-right py-1 px-3">Stability (cal)</th>
                  <th className="text-right py-1 pl-3">Off-Rail ({imp ? 'ft/s' : 'm/s'})</th>
                </tr>
              </thead>
              <tbody>
                {valid.map(p => (
                  <tr key={p.param_value} className="border-b border-gray-800/40 hover:bg-gray-800/30">
                    <td className="py-0.5 pr-4 font-mono">{p.param_value.toFixed(2)}</td>
                    <td className="py-0.5 px-3 text-right font-mono">{fmtAlt(p.apogee_m_agl ?? 0).toLocaleString()}</td>
                    <td className="py-0.5 px-3 text-right font-mono">{((p.max_speed_ms ?? 0) * (imp ? M_FT : 1)).toFixed(1)}</td>
                    <td className="py-0.5 px-3 text-right font-mono">{(p.stability_cal ?? 0).toFixed(2)}</td>
                    <td className="py-0.5 pl-3 text-right font-mono">{((p.off_rail_velocity ?? 0) * (imp ? M_FT : 1)).toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
