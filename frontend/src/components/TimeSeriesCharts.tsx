import { useState } from 'react';
import PlotlyImport from 'react-plotly.js';
const Plot = (PlotlyImport as any).default ?? PlotlyImport;
import type { TimeSeriesData } from '../types';

export type UnitSystem = 'metric' | 'imperial';
export type StabilityUnit = 'cal' | 'pct';

interface TimeSeriesChartsProps {
  orTimeseries: TimeSeriesData | undefined;
  rocketPyTimeseries: TimeSeriesData;
  burnOutTimeS: number;
  unitSystem: UnitSystem;
  stabilityUnit: StabilityUnit;
}

const M_TO_FT = 3.28084;
const MS_TO_FTS = 3.28084;
const N_TO_LBF = 0.224809;

function convertAlt(v: number[], sys: UnitSystem) {
  return sys === 'imperial' ? v.map(x => x * M_TO_FT) : v;
}
function convertVel(v: number[], sys: UnitSystem) {
  return sys === 'imperial' ? v.map(x => x * MS_TO_FTS) : v;
}
function convertThrust(v: number[], sys: UnitSystem) {
  return sys === 'imperial' ? v.map(x => x * N_TO_LBF) : v;
}
function convertStab(v: number[], unit: StabilityUnit, calToPct: number) {
  return unit === 'pct' ? v.map(x => x * calToPct) : v;
}

export function TimeSeriesCharts({
  orTimeseries,
  rocketPyTimeseries,
  burnOutTimeS,
  unitSystem,
  stabilityUnit,
}: TimeSeriesChartsProps) {
  const altUnit = unitSystem === 'imperial' ? 'ft AGL' : 'm AGL';
  const velUnit = unitSystem === 'imperial' ? 'ft/s' : 'm/s';
  const thrustUnit = unitSystem === 'imperial' ? 'lbf' : 'N';

  const stabUnit = stabilityUnit === 'pct' ? '%' : 'cal';
  // 1 cal reference line = 1.0 cal; "safe" band 1.5–2.5 cal or ~6–10%
  // Derive scale factor from rocketpy data (approximate — for reference lines only)
  // Reference lines in calibers: min 1.5 cal, ideal 2.5 cal
  const stabMin = stabilityUnit === 'pct' ? 6 : 1.5;
  const stabMax = stabilityUnit === 'pct' ? 10 : 2.5;

  const layout = (title: string, yLabel: string, shapes?: object[]) => ({
    title: { text: title, font: { color: '#e2e8f0', size: 14 } },
    paper_bgcolor: '#111827',
    plot_bgcolor: '#1f2937',
    font: { color: '#9ca3af' },
    xaxis: { title: { text: 'Time (s)', font: { color: '#9ca3af' } }, gridcolor: '#374151', zerolinecolor: '#4b5563' },
    yaxis: { title: { text: yLabel, font: { color: '#9ca3af' } }, gridcolor: '#374151', zerolinecolor: '#4b5563' },
    legend: { font: { color: '#e2e8f0' }, bgcolor: 'rgba(0,0,0,0)' },
    margin: { t: 45, r: 15, b: 45, l: 70 },
    autosize: true,
    hovermode: 'x unified',
    shapes: shapes ?? [],
  });

  const config = {
    responsive: true,
    scrollZoom: true,
    displayModeBar: 'hover' as const,
    modeBarButtonsToRemove: ['lasso2d', 'select2d', 'toImage'] as any,
  };

  const orTrace = (y: number[]) => ({
    x: orTimeseries!.time,
    y,
    type: 'scatter',
    mode: 'lines',
    name: 'OpenRocket',
    line: { color: '#60a5fa', width: 2 },
  });

  const rpyTrace = (y: number[], name = 'RocketPy') => ({
    x: rocketPyTimeseries.time,
    y,
    name,
    type: 'scatter',
    mode: 'lines',
    line: { color: '#f87171', width: 2 },
  });

  const refLine = (y0: number, color: string) => ({
    type: 'line', x0: 0, x1: 1, xref: 'paper', y0, y1: y0,
    line: { color, dash: 'dash', width: 1 },
  });

  // Stability: estimate cal→pct factor from rocketpy timeseries max
  // (approximation for reference lines; actual pct comes from backend scalar)
  const orStabConverted = orTimeseries
    ? convertStab(orTimeseries.stability, stabilityUnit, stabilityUnit === 'pct' ? (stabMax / 2.5) : 1)
    : undefined;
  const rpyStabConverted = convertStab(
    rocketPyTimeseries.stability, stabilityUnit,
    stabilityUnit === 'pct' ? (stabMax / 2.5) : 1,
  );

  // Thrust: truncate to burnout + 2s
  const thrustCutoff = burnOutTimeS + 2;
  const thrustIdxEnd = rocketPyTimeseries.time.findIndex(t => t > thrustCutoff);
  const thrustTimeSlice = thrustIdxEnd === -1
    ? rocketPyTimeseries.time
    : rocketPyTimeseries.time.slice(0, thrustIdxEnd);
  const thrustValSlice = thrustIdxEnd === -1
    ? rocketPyTimeseries.thrust
    : rocketPyTimeseries.thrust.slice(0, thrustIdxEnd);

  const altitudeData = [
    ...(orTimeseries ? [orTrace(convertAlt(orTimeseries.altitude, unitSystem))] : []),
    rpyTrace(convertAlt(rocketPyTimeseries.altitude, unitSystem)),
  ];

  const velocityData = [
    ...(orTimeseries ? [orTrace(convertVel(orTimeseries.velocity, unitSystem))] : []),
    rpyTrace(convertVel(rocketPyTimeseries.velocity, unitSystem)),
  ];

  const machData = [
    ...(orTimeseries ? [orTrace(orTimeseries.mach)] : []),
    rpyTrace(rocketPyTimeseries.mach),
  ];

  const stabilityData = [
    ...(orStabConverted ? [orTrace(orStabConverted)] : []),
    rpyTrace(rpyStabConverted),
  ];

  const thrustData = [{
    x: thrustTimeSlice,
    y: convertThrust(thrustValSlice, unitSystem),
    type: 'scatter',
    mode: 'lines',
    name: 'RocketPy',
    line: { color: '#fb923c', width: 2 },
    fill: 'tozeroy',
    fillcolor: 'rgba(251,146,60,0.15)',
  }];

  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-gray-900 rounded-xl p-4">
      <button
        onClick={() => setExpanded(v => !v)}
        className="flex items-center gap-2 w-full text-left"
      >
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">Flight Data</h2>
        <svg
          className={`w-4 h-4 text-gray-500 transition-transform ${expanded ? 'rotate-90' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>
      {expanded && (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
        <div className="w-full">
          <Plot
            data={altitudeData as any}
            layout={layout('Altitude', `Altitude (${altUnit})`) as any}
            config={config}
            style={{ width: '100%', height: '300px' }}
            useResizeHandler
          />
        </div>
        <div className="w-full">
          <Plot
            data={velocityData as any}
            layout={layout('Velocity', `Velocity (${velUnit})`) as any}
            config={config}
            style={{ width: '100%', height: '300px' }}
            useResizeHandler
          />
        </div>
        <div className="w-full">
          <Plot
            data={machData as any}
            layout={layout('Mach Number', 'Mach Number', [refLine(1, '#94a3b8')]) as any}
            config={config}
            style={{ width: '100%', height: '300px' }}
            useResizeHandler
          />
        </div>
        <div className="w-full">
          <Plot
            data={stabilityData as any}
            layout={layout(`Stability Margin`, `Stability (${stabUnit})`, [
              refLine(stabMin, '#fbbf24'),
              refLine(stabMax, '#34d399'),
            ]) as any}
            config={config}
            style={{ width: '100%', height: '300px' }}
            useResizeHandler
          />
        </div>
        <div className="md:col-span-2 w-full">
          <Plot
            data={thrustData as any}
            layout={layout(`Thrust (0 – burnout+2s)`, `Thrust (${thrustUnit})`) as any}
            config={config}
            style={{ width: '100%', height: '300px' }}
            useResizeHandler
          />
        </div>
      </div>
      )}
    </div>
  );
}
