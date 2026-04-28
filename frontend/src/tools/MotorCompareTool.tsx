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

interface MotorResult {
  motor_id: string;
  designation?: string;
  apogee_m_agl?: number;
  max_speed_ms?: number;
  max_mach?: number;
  stability_cal?: number;
  off_rail_velocity?: number;
  burn_out_time_s?: number;
  error?: string;
}

interface MotorSuggestion {
  id: string;
  designation: string;
  manufacturer: string;
  impulse_class: string;
  avg_thrust_n?: number;
}

const M_FT = 3.28084;

export function MotorCompareTool({ result, config, unitSystem }: Props) {
  const imp = unitSystem === 'imperial';
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<MotorSuggestion[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedMotors, setSelectedMotors] = useState<MotorSuggestion[]>([]);
  const [running, setRunning] = useState(false);
  const [compareResults, setCompareResults] = useState<MotorResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [orkFile, setOrkFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const originalMotor = result.rocket_params?.motor_designation ?? 'Original';

  const handleSearch = (q: string) => {
    setQuery(q);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (q.length < 2) { setSuggestions([]); return; }
    searchTimer.current = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const r = await fetch(`/api/motors/search?q=${encodeURIComponent(q)}`);
        if (!r.ok) throw new Error('Search failed');
        const j = await r.json();
        setSuggestions(j.results ?? []);
      } catch { setSuggestions([]); }
      finally { setSearchLoading(false); }
    }, 300);
  };

  const addMotor = (m: MotorSuggestion) => {
    if (selectedMotors.length >= 5) return;
    if (selectedMotors.find(s => s.id === m.id)) return;
    setSelectedMotors(prev => [...prev, m]);
    setQuery('');
    setSuggestions([]);
  };

  const removeMotor = (id: string) => setSelectedMotors(prev => prev.filter(m => m.id !== id));

  const handleCompare = async () => {
    if (!orkFile) { setError('Re-select your .ork file'); return; }
    if (selectedMotors.length === 0) { setError('Add at least one motor'); return; }
    setRunning(true);
    setError(null);
    setCompareResults(null);
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
        motor_ids: selectedMotors.map(m => m.id).join(','),
      });
      const response = await fetch(`/api/motors/compare?${params}`, { method: 'POST', body: formData });
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
            if (ev.stage === 'done') setCompareResults(ev.results as MotorResult[]);
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
  const valid = compareResults?.filter(r => !r.error) ?? [];

  const barLayout: any = {
    paper_bgcolor: '#111827', plot_bgcolor: '#1f2937',
    margin: { t: 10, r: 20, b: 80, l: 60 },
    height: 260, autosize: true,
    barmode: 'group',
    xaxis: { gridcolor: '#374151', color: '#6b7280', tickfont: { size: 8 }, tickangle: -20 },
    yaxis: { title: { text: `Apogee (${altUnit})`, font: { color: '#9ca3af', size: 10 } }, gridcolor: '#374151', color: '#6b7280', tickfont: { size: 9 } },
    legend: { font: { color: '#9ca3af', size: 9 }, bgcolor: 'transparent' },
  };

  const colors = ['#60a5fa', '#34d399', '#f59e0b', '#f472b6', '#a78bfa'];

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-gray-200 uppercase tracking-wide">Motor Comparison</h3>

      {/* File selector */}
      <div className="flex items-center gap-3 text-xs">
        <input ref={fileInputRef} type="file" accept=".ork" className="hidden"
          onChange={e => setOrkFile(e.target.files?.[0] ?? null)} />
        <button onClick={() => fileInputRef.current?.click()}
          className="bg-gray-800 hover:bg-gray-700 text-gray-300 px-3 py-1.5 rounded-lg transition-colors border border-gray-700">
          {orkFile ? `📄 ${orkFile.name}` : 'Select .ork file'}
        </button>
        <span className="text-gray-600">Original: <span className="text-gray-400">{originalMotor}</span></span>
      </div>

      {/* Motor search */}
      <div className="relative">
        <div className="flex items-center gap-2">
          <input
            type="text" value={query} onChange={e => handleSearch(e.target.value)}
            placeholder="Search motors (e.g. M2500, L1420)..."
            disabled={selectedMotors.length >= 5}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 disabled:opacity-40 placeholder-gray-600"
          />
          {searchLoading && <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin shrink-0" />}
        </div>
        {suggestions.length > 0 && (
          <div className="absolute z-20 w-full bg-gray-800 border border-gray-700 rounded-lg mt-1 shadow-xl overflow-hidden">
            {suggestions.map(s => (
              <button key={s.id} type="button" onClick={() => addMotor(s)}
                className="w-full text-left px-3 py-2 text-sm text-gray-300 hover:bg-gray-700 border-b border-gray-700/50 last:border-0">
                <span className="font-semibold text-white">{s.designation}</span>
                <span className="text-gray-500 ml-2">{s.manufacturer}</span>
                <span className="float-right text-gray-600 text-xs">{s.impulse_class}-class · {s.avg_thrust_n?.toFixed(0)} N avg</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Selected motors */}
      {selectedMotors.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {selectedMotors.map(m => (
            <span key={m.id} className="flex items-center gap-1.5 bg-blue-900/40 border border-blue-700/50 rounded-full px-2.5 py-1 text-xs text-blue-300">
              {m.designation}
              <button onClick={() => removeMotor(m.id)} className="text-blue-500 hover:text-white">×</button>
            </span>
          ))}
        </div>
      )}

      <button onClick={handleCompare} disabled={running || !orkFile || selectedMotors.length === 0}
        className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold px-4 py-2 rounded-lg transition-colors text-sm">
        {running ? (
          <span className="flex items-center gap-2">
            <div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
            Running…
          </span>
        ) : 'Compare Motors'}
      </button>

      {error && <p className="text-xs text-red-400 bg-red-950/40 border border-red-800 rounded-lg px-3 py-2">{error}</p>}

      {valid.length > 0 && (
        <>
          <Plot
            data={valid.map((r, i) => ({
              x: [r.designation ?? r.motor_id],
              y: [fmtAlt(r.apogee_m_agl ?? 0)],
              type: 'bar', name: r.designation ?? r.motor_id,
              marker: { color: colors[i % colors.length] },
            }))}
            layout={{ ...barLayout, yaxis: { ...barLayout.yaxis, title: { text: `Apogee (${altUnit})`, font: { color: '#9ca3af', size: 10 } } } }}
            config={{ responsive: true, displayModeBar: false }}
            style={{ width: '100%' }}
            useResizeHandler
          />

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-700 uppercase text-[10px]">
                  <th className="text-left py-1.5 pr-4">Motor</th>
                  <th className="text-right py-1.5 px-3">Apogee ({altUnit})</th>
                  <th className="text-right py-1.5 px-3">Max Vel ({imp ? 'ft/s' : 'm/s'})</th>
                  <th className="text-right py-1.5 px-3">Max Mach</th>
                  <th className="text-right py-1.5 px-3">Stability (cal)</th>
                  <th className="text-right py-1.5 pl-3">Burn (s)</th>
                </tr>
              </thead>
              <tbody>
                {valid.map((r, i) => (
                  <tr key={r.motor_id} className="border-b border-gray-800/40 hover:bg-gray-800/30">
                    <td className="py-1 pr-4">
                      <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: colors[i % colors.length] }} />
                      <span className="text-gray-200 font-medium">{r.designation ?? r.motor_id}</span>
                    </td>
                    <td className="py-1 px-3 text-right font-mono">{fmtAlt(r.apogee_m_agl ?? 0).toLocaleString()}</td>
                    <td className="py-1 px-3 text-right font-mono">{((r.max_speed_ms ?? 0) * (imp ? M_FT : 1)).toFixed(1)}</td>
                    <td className="py-1 px-3 text-right font-mono">{(r.max_mach ?? 0).toFixed(3)}</td>
                    <td className="py-1 px-3 text-right font-mono">{(r.stability_cal ?? 0).toFixed(2)}</td>
                    <td className="py-1 pl-3 text-right font-mono">{(r.burn_out_time_s ?? 0).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {compareResults?.filter(r => r.error).map(r => (
            <p key={r.motor_id} className="text-xs text-red-400">{r.motor_id}: {r.error}</p>
          ))}
        </>
      )}
    </div>
  );
}
