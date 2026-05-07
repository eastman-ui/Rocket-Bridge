import { useState, useCallback } from 'react';
import PlotlyImport from 'react-plotly.js';
const Plot = (PlotlyImport as any).default ?? PlotlyImport;
import type { ComparisonResponse } from '../types';
import type { UnitSystem } from '../components/TimeSeriesCharts';

interface Props {
  result: ComparisonResponse;
  unitSystem: UnitSystem;
}

interface AltimeterData {
  time: number[];
  altitude: number[];   // stored in meters
  velocity?: number[];  // stored in m/s
}

function parseCSV(text: string): { data: AltimeterData; skipped: number } | { error: string } {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return { error: 'File is empty or has no data rows.' };

  const headers = lines[0].toLowerCase().split(',').map(h => h.trim());
  const timeIdx = headers.indexOf('time');
  const altIdx = headers.indexOf('altitude');
  const velIdx = headers.indexOf('velocity');

  if (timeIdx === -1) return { error: 'Missing required column: "time"' };
  if (altIdx === -1) return { error: 'Missing required column: "altitude"' };

  const time: number[] = [];
  const altitude: number[] = [];
  const velocity: number[] = [];
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const t = parseFloat(cols[timeIdx]);
    const a = parseFloat(cols[altIdx]);
    if (!Number.isFinite(t) || !Number.isFinite(a)) { skipped++; continue; }
    time.push(t);
    altitude.push(a);
    if (velIdx !== -1) {
      const v = parseFloat(cols[velIdx]);
      velocity.push(Number.isFinite(v) ? v : NaN);
    }
  }

  if (time.length === 0) return { error: 'No valid data rows found.' };

  // Auto-detect feet: max altitude > 9000 → assume feet, convert to meters
  const maxAlt = altitude.reduce((m, v) => (v > m ? v : m), -Infinity);
  const isFeet = maxAlt > 9000;
  const altM = isFeet ? altitude.map(a => a * 0.3048) : altitude;
  const velMs = velIdx !== -1
    ? (isFeet ? velocity.map(v => v * 0.3048) : velocity)
    : undefined;

  return { data: { time, altitude: altM, velocity: velMs }, skipped };
}

export function AltimeterTool({ result, unitSystem }: Props) {
  const imp = unitSystem === 'imperial';
  const [altData, setAltData] = useState<AltimeterData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [fileName, setFileName] = useState('');

  const rpy = result.rocketpy_results;
  const or = result.or_results;

  const handleFile = useCallback((file: File) => {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const parsed = parseCSV(text);
      if ('error' in parsed) {
        setError(parsed.error);
        setAltData(null);
        setSkipped(0);
      } else {
        setError(null);
        setAltData(parsed.data);
        setSkipped(parsed.skipped);
      }
    };
    reader.readAsText(file);
  }, []);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  // Derived metrics from altimeter data (all stored in meters/m/s)
  const altiApogeeM = altData
    ? altData.altitude.reduce((m, v) => (v > m ? v : m), -Infinity)
    : null;
  const altiApogeeIdx = altData && altiApogeeM !== null
    ? altData.altitude.indexOf(altiApogeeM)
    : -1;
  const altiApogeeT = altiApogeeIdx >= 0 ? altData!.time[altiApogeeIdx] : null;
  const altiMaxVelMs = altData?.velocity
    ? (() => {
        const max = altData.velocity!.reduce((m, v) => (Number.isFinite(v) && v > m ? v : m), -Infinity);
        return Number.isFinite(max) ? max : null;
      })()
    : null;

  const scale = imp ? 3.28084 : 1;
  const unit = imp ? 'ft' : 'm';
  const velScale = imp ? 3.28084 : 1;
  const velUnit = imp ? 'ft/s' : 'm/s';

  function deltaCell(altiM: number | null, simM: number) {
    if (altiM === null) return { text: '—', color: 'text-gray-600' };
    if (simM === 0) return { text: '—', color: 'text-gray-600' };
    const diff = (altiM - simM) * scale;
    const pct = Math.abs((altiM - simM) / simM) * 100;
    const diffSign = diff >= 0 ? '+' : '';
    const pctSign = diff >= 0 ? '+' : '-';
    const color = pct <= 5 ? 'text-green-400' : pct <= 15 ? 'text-amber-400' : 'text-red-400';
    return { text: `${diffSign}${diff.toFixed(0)} ${unit} (${pctSign}${pct.toFixed(1)}%)`, color };
  }

  function timeDelta(altiT: number | null, simT: number) {
    if (altiT === null) return { text: '—', color: 'text-gray-600' };
    if (simT === 0) return { text: '—', color: 'text-gray-600' };
    const diff = altiT - simT;
    const pct = Math.abs(diff / simT) * 100;
    const diffSign = diff >= 0 ? '+' : '';
    const pctSign = diff >= 0 ? '+' : '-';
    const color = pct <= 5 ? 'text-green-400' : pct <= 15 ? 'text-amber-400' : 'text-red-400';
    return { text: `${diffSign}${diff.toFixed(1)} s (${pctSign}${pct.toFixed(1)}%)`, color };
  }

  // Chart traces
  const rpyAltTrace = {
    x: rpy.timeseries.time,
    y: rpy.timeseries.altitude.map(a => a * scale),
    type: 'scatter', mode: 'lines', name: 'RocketPy',
    line: { color: '#60a5fa', width: 2 },
  };

  const orAltTrace = or.timeseries ? {
    x: or.timeseries.time,
    y: or.timeseries.altitude.map(a => a * scale),
    type: 'scatter', mode: 'lines', name: 'OpenRocket',
    line: { color: '#9ca3af', width: 1.5, dash: 'dash' },
  } : null;

  const altiAltTrace = altData ? {
    x: altData.time,
    y: altData.altitude.map(a => a * scale),
    type: 'scatter', mode: 'lines', name: 'Altimeter',
    line: { color: '#34d399', width: 2 },
  } : null;

  const rpyVelTrace = {
    x: rpy.timeseries.time,
    y: rpy.timeseries.velocity.map(v => v * velScale),
    type: 'scatter', mode: 'lines', name: 'RocketPy',
    line: { color: '#60a5fa', width: 2 },
  };

  const altiVelTrace = altData?.velocity ? {
    x: altData.time,
    y: altData.velocity.map(v => v * velScale),
    type: 'scatter', mode: 'lines', name: 'Altimeter',
    line: { color: '#34d399', width: 2 },
  } : null;

  const chartLayout = (xLabel: string, yLabel: string): any => ({
    paper_bgcolor: '#111827', plot_bgcolor: '#1f2937',
    margin: { t: 10, r: 20, b: 45, l: 55 },
    height: 260, autosize: true,
    xaxis: {
      title: { text: xLabel, font: { color: '#9ca3af', size: 10 } },
      gridcolor: '#374151', color: '#6b7280', tickfont: { size: 9 },
    },
    yaxis: {
      title: { text: yLabel, font: { color: '#9ca3af', size: 10 } },
      gridcolor: '#374151', color: '#6b7280', tickfont: { size: 9 },
    },
    legend: { font: { color: '#9ca3af', size: 9 }, bgcolor: 'transparent' },
  });

  const altChartTraces = [
    rpyAltTrace,
    ...(orAltTrace ? [orAltTrace] : []),
    ...(altiAltTrace ? [altiAltTrace] : []),
  ];

  const rows = [
    {
      label: 'Apogee AGL',
      alti: altiApogeeM !== null
        ? `${Math.round(altiApogeeM * scale).toLocaleString()} ${unit}`
        : '—',
      rpy: `${Math.round(rpy.apogee_m_agl * scale).toLocaleString()} ${unit}`,
      or: or.apogee_m_agl != null
        ? `${Math.round(or.apogee_m_agl * scale).toLocaleString()} ${unit}`
        : '—',
      delta: deltaCell(altiApogeeM, rpy.apogee_m_agl),
    },
    {
      label: 'Time to Apogee',
      alti: altiApogeeT !== null ? `${altiApogeeT.toFixed(1)} s` : '—',
      rpy: `${rpy.apogee_time_s.toFixed(1)} s`,
      or: or.time_to_apogee_s != null ? `${or.time_to_apogee_s.toFixed(1)} s` : '—',
      delta: timeDelta(altiApogeeT, rpy.apogee_time_s),
    },
    {
      label: 'Max Velocity',
      alti: altiMaxVelMs !== null
        ? `${Math.round(altiMaxVelMs * velScale)} ${velUnit}`
        : '—',
      rpy: `${Math.round(rpy.max_speed_ms * velScale)} ${velUnit}`,
      or: or.max_velocity_ms != null
        ? `${Math.round(or.max_velocity_ms * velScale)} ${velUnit}`
        : '—',
      delta: deltaCell(altiMaxVelMs, rpy.max_speed_ms),
    },
  ];

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-gray-200 uppercase tracking-wide">
        Altimeter Data Overlay
      </h3>

      {/* CSV format */}
      <details className="bg-gray-950 border border-gray-800 rounded-xl p-3 text-xs">
        <summary className="text-blue-400 font-medium cursor-pointer select-none">
          CSV Format
        </summary>
        <div className="mt-2 space-y-1.5">
          <pre className="text-gray-400 font-mono text-[11px] leading-relaxed whitespace-pre">
{`time,altitude[,velocity]
0.00,0
0.05,1.2,3.4
0.10,4.8,12.1`}
          </pre>
          <p className="text-gray-600">
            Headers required (case-insensitive) · time in seconds · altitude in m or ft
            (auto-detected: max &gt; 9000 treated as ft) · velocity optional
          </p>
        </div>
      </details>

      {/* Upload row */}
      <div className="flex items-center gap-3 flex-wrap">
        <label className="cursor-pointer bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-gray-300 text-xs hover:border-gray-500 transition-colors">
          Select CSV
          <input type="file" accept=".csv,.txt" onChange={onFileChange} className="hidden" />
        </label>
        <span className="text-xs text-gray-500">{fileName || 'No file loaded'}</span>
        {skipped > 0 && (
          <span className="text-xs text-amber-400">{skipped} row{skipped !== 1 ? 's' : ''} skipped (unparseable)</span>
        )}
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {/* Comparison table — shown once CSV is loaded */}
      {altData && (
        <div>
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">
            Results Comparison
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse min-w-[500px]">
              <thead>
                <tr className="text-[10px] text-gray-600 uppercase">
                  {['Metric', 'Altimeter', 'RocketPy', 'OpenRocket', 'Δ (Alti vs RPy)'].map(h => (
                    <td key={h} className={`py-1.5 px-2 border-b border-gray-800 ${h !== 'Metric' ? 'text-right' : ''}`}>
                      {h}
                    </td>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={row.label} className={i % 2 === 1 ? 'bg-gray-950/50' : ''}>
                    <td className="py-2 px-2 text-gray-400 border-b border-gray-800/50">{row.label}</td>
                    <td className="py-2 px-2 text-right text-green-400 font-mono border-b border-gray-800/50">{row.alti}</td>
                    <td className="py-2 px-2 text-right text-gray-200 font-mono border-b border-gray-800/50">{row.rpy}</td>
                    <td className="py-2 px-2 text-right text-gray-400 font-mono border-b border-gray-800/50">{row.or}</td>
                    <td className={`py-2 px-2 text-right font-mono border-b border-gray-800/50 ${row.delta.color}`}>
                      {row.delta.text}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Altitude chart — always shown */}
      <div>
        <p className="text-[11px] text-gray-500 mb-1.5">Altitude vs Time</p>
        <Plot
          data={altChartTraces as any}
          layout={chartLayout('Time (s)', `Altitude AGL (${unit})`)}
          config={{ responsive: true, displayModeBar: false }}
          style={{ width: '100%' }}
          useResizeHandler
        />
      </div>

      {/* Velocity chart — only if CSV has velocity column */}
      {altData?.velocity && (
        <div>
          <p className="text-[11px] text-gray-500 mb-1.5">Velocity vs Time</p>
          <Plot
            data={[rpyVelTrace, ...(altiVelTrace ? [altiVelTrace] : [])] as any}
            layout={chartLayout('Time (s)', `Velocity (${velUnit})`)}
            config={{ responsive: true, displayModeBar: false }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        </div>
      )}
    </div>
  );
}
