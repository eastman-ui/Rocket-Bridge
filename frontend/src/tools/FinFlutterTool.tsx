import { useState, useMemo } from 'react';
import PlotlyImport from 'react-plotly.js';
const Plot = (PlotlyImport as any).default ?? PlotlyImport;
import type { ComparisonResponse } from '../types';
import type { UnitSystem } from '../components/TimeSeriesCharts';

interface Props {
  result: ComparisonResponse;
  unitSystem: UnitSystem;
}

const MATERIALS = [
  { label: 'Aluminum 6061', G: 26e9 },
  { label: 'G10 Fiberglass', G: 13e9 },
  { label: 'Carbon Fiber (UD)', G: 25e9 },
  { label: 'Plywood', G: 0.6e9 },
  { label: 'Custom', G: null },
];

// ISA atmosphere: returns { pressure_Pa, temperature_K, speed_of_sound_ms }
function isa(altM: number) {
  const T0 = 288.15, L = 0.0065, P0 = 101325, g = 9.80665, R = 287.05, gamma = 1.4;
  if (altM <= 11000) {
    const T = T0 - L * altM;
    const P = P0 * Math.pow(T / T0, g / (L * R));
    return { P, T, a: Math.sqrt(gamma * R * T) };
  }
  const T11 = T0 - L * 11000;
  const P11 = P0 * Math.pow(T11 / T0, g / (L * R));
  const T = T11;
  const P = P11 * Math.exp(-g * (altM - 11000) / (R * T11));
  return { P, T, a: Math.sqrt(gamma * R * T) };
}

// Raymer flutter velocity (m/s)
// Vf = a * sqrt( G * (t_c)^3 * (AR+2) / (1.337 * AR^3 * P * (1+lambda)) )
function flutterVelocity(
  G: number, tc: number, rootChord: number, tipChord: number, span: number, altM: number
): number {
  const AR = (2 * span) / (rootChord + tipChord);
  const lambda = tipChord / rootChord;
  const { P, a } = isa(altM);
  const numerator = G * Math.pow(tc, 3) * (AR + 2);
  const denominator = 1.337 * Math.pow(AR, 3) * P * (1 + lambda);
  if (denominator <= 0) return 0;
  return a * Math.sqrt(numerator / denominator);
}

export function FinFlutterTool({ result, unitSystem }: Props) {
  const imp = unitSystem === 'imperial';
  const rpy = result.rocketpy_results;

  // Extract fin geometry from timeseries (we don't have raw params in frontend)
  // Use a reasonable default — user can override
  const [rootChord, setRootChord] = useState(0.254);   // m
  const [tipChord, setTipChord] = useState(0.038);     // m
  const [span, setSpan] = useState(0.14);               // m
  const [thickness, setThickness] = useState(0.00381); // m (absolute fin thickness)

  // t/c = thickness / mean_chord; recomputed from absolute thickness
  const meanChord = (rootChord + tipChord) / 2;
  const tc = meanChord > 0 ? thickness / meanChord : 0.06;
  const [matIdx, setMatIdx] = useState(0);
  const [customG, setCustomG] = useState(20e9);

  const G = MATERIALS[matIdx].G ?? customG;
  const apogeeM = rpy.apogee_m_agl;
  const maxMach = rpy.max_mach;

  // Compute flutter velocity across altitude range
  const altPoints = useMemo(() => {
    const pts = [];
    const steps = 80;
    for (let i = 0; i <= steps; i++) {
      const alt = (apogeeM * i) / steps;
      const vf = flutterVelocity(G, tc, rootChord, tipChord, span, alt);
      const { a } = isa(alt);
      pts.push({ alt, vf, mach_f: vf / a });
    }
    return pts;
  }, [G, tc, rootChord, tipChord, span, apogeeM]);

  // Flutter at apogee (conservative — lowest air density in flight envelope)
  const { vf: vfApogee, mach_f: machFlutterApogee } = altPoints[altPoints.length - 1];
  const safetyFactor = machFlutterApogee / maxMach;
  const status = safetyFactor >= 1.2 ? 'safe' : safetyFactor >= 1.0 ? 'warning' : 'danger';

  const statusColor = status === 'safe' ? 'text-green-400' : status === 'warning' ? 'text-yellow-400' : 'text-red-400';
  const statusBg = status === 'safe' ? 'bg-green-900/30 border-green-700/50' : status === 'warning' ? 'bg-yellow-900/30 border-yellow-700/50' : 'bg-red-900/30 border-red-700/50';
  const statusLabel = status === 'safe' ? 'Safe' : status === 'warning' ? 'Near Flutter' : 'Flutter Risk';

  // Mach timeseries from rpy
  const machTs = rpy.timeseries.mach;
  const timeTs = rpy.timeseries.time;
  const altTs = rpy.timeseries.altitude;

  // Plot traces
  const flutterTrace = {
    x: altPoints.map(p => imp ? p.alt * 3.28084 : p.alt),
    y: altPoints.map(p => p.mach_f),
    type: 'scatter', mode: 'lines',
    name: 'Flutter Mach',
    line: { color: '#f59e0b', width: 2, dash: 'dash' },
  };

  // Rocket mach vs altitude (scatter altitude vs mach)
  const rocketMachTrace = {
    x: altTs.map(a => imp ? a * 3.28084 : a),
    y: machTs,
    type: 'scatter', mode: 'lines',
    name: 'Rocket Mach',
    line: { color: '#60a5fa', width: 2 },
  };

  const layout: any = {
    paper_bgcolor: '#111827', plot_bgcolor: '#1f2937',
    margin: { t: 10, r: 20, b: 45, l: 55 },
    height: 280,
    autosize: true,
    xaxis: {
      title: { text: `Altitude AGL (${imp ? 'ft' : 'm'})`, font: { color: '#9ca3af', size: 10 } },
      gridcolor: '#374151', color: '#6b7280', tickfont: { size: 9 },
    },
    yaxis: {
      title: { text: 'Mach', font: { color: '#9ca3af', size: 10 } },
      gridcolor: '#374151', color: '#6b7280', tickfont: { size: 9 },
    },
    legend: { font: { color: '#9ca3af', size: 9 }, bgcolor: 'transparent' },
  };

  const fmt = (v: number, d = 2) => v.toFixed(d);
  const fmtV = (ms: number) => imp ? `${(ms * 3.28084).toFixed(0)} ft/s` : `${ms.toFixed(0)} m/s`;

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-gray-200 uppercase tracking-wide">Fin Flutter Analysis</h3>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
        {/* Inputs */}
        <div className="space-y-3">
          <p className="text-xs text-gray-500">Fin geometry (pre-fill from your design, or edit):</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              { label: 'Root chord', unit: imp ? 'in' : 'm', val: rootChord,  set: setRootChord,  scale: imp ? 39.3701 : 1, step: 0.1 },
              { label: 'Tip chord',  unit: imp ? 'in' : 'm', val: tipChord,   set: setTipChord,   scale: imp ? 39.3701 : 1, step: 0.1 },
              { label: 'Span',       unit: imp ? 'in' : 'm', val: span,       set: setSpan,       scale: imp ? 39.3701 : 1, step: 0.1 },
              { label: 'Thickness',  unit: imp ? 'in' : 'mm', val: thickness, set: setThickness,  scale: imp ? 39.3701 : 1000, step: 0.01 },
            ].map(({ label, unit, val, set, scale, step }) => (
              <div key={label} className="flex flex-col gap-1">
                <label className="text-xs text-gray-400">{label}{unit && <span className="ml-1 text-gray-600">{unit}</span>}</label>
                <input
                  type="number"
                  step={step}
                  value={parseFloat((val * scale).toFixed(3))}
                  onChange={e => set(parseFloat(e.target.value) / scale)}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:border-blue-500"
                />
              </div>
            ))}
          </div>
          <p className="text-[10px] text-gray-600">t/c ratio computed from thickness ÷ mean chord = {tc.toFixed(4)}</p>

          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-400">Material</label>
              <select
                value={matIdx}
                onChange={e => setMatIdx(Number(e.target.value))}
                className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:border-blue-500"
              >
                {MATERIALS.map((m, i) => (
                  <option key={m.label} value={i}>{m.label}</option>
                ))}
              </select>
            </div>
            {MATERIALS[matIdx].G === null && (
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-400">Shear modulus <span className="text-gray-600">GPa</span></label>
                <input
                  type="number" step={0.5}
                  value={(customG / 1e9).toFixed(1)}
                  onChange={e => setCustomG(parseFloat(e.target.value) * 1e9)}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:border-blue-500"
                />
              </div>
            )}
          </div>

          {/* Chart */}
          <Plot
            data={[flutterTrace, rocketMachTrace]}
            layout={layout}
            config={{ responsive: true, displayModeBar: false }}
            style={{ width: '100%' }}
            useResizeHandler
          />
          <p className="text-xs text-gray-600">Dashed = flutter threshold · Blue = rocket Mach profile · Flutter occurs where blue crosses dashed line</p>
        </div>

        {/* Results */}
        <div className="space-y-3">
          <div className={`rounded-xl border px-4 py-3 ${statusBg}`}>
            <p className={`text-base font-bold ${statusColor}`}>{statusLabel}</p>
            <p className="text-xs text-gray-400 mt-0.5">Safety factor: <span className={`font-semibold ${statusColor}`}>{fmt(safetyFactor, 2)}×</span></p>
          </div>

          {[
            { label: 'Flutter velocity (apogee alt)', value: fmtV(vfApogee) },
            { label: 'Flutter Mach (apogee alt)', value: `Mach ${fmt(machFlutterApogee, 3)}` },
            { label: 'Max rocket Mach', value: `Mach ${fmt(maxMach, 3)}` },
            { label: 'Aspect ratio (AR)', value: fmt((2 * span) / (rootChord + tipChord), 2) },
            { label: 'Taper ratio (λ)', value: fmt(tipChord / rootChord, 3) },
            { label: 't/c ratio', value: fmt(tc, 4) },
            { label: 'Shear modulus (G)', value: `${(G / 1e9).toFixed(1)} GPa` },
          ].map(({ label, value }) => (
            <div key={label} className="flex items-center justify-between py-1 border-b border-gray-800/60">
              <span className="text-xs text-gray-400">{label}</span>
              <span className="text-xs text-gray-200 font-mono">{value}</span>
            </div>
          ))}

          <p className="text-[10px] text-gray-600 leading-relaxed">
            Uses Raymer's simplified flutter formula. Evaluated at apogee altitude (lowest density = worst case). Does not account for dynamic pressure loading or resonance.
          </p>
        </div>
      </div>
    </div>
  );
}
