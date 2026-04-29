import PlotlyImport from 'react-plotly.js';
const Plot = (PlotlyImport as any).default ?? PlotlyImport;
import type { Trajectory3D } from '../types';
import type { UnitSystem } from './TimeSeriesCharts';

const M_FT = 3.28084;

interface TrajectoryPlotProps {
  trajectory: Trajectory3D;
  apogeeAgl: number;
  apogeeTimeS: number;
  burnOutTimeS: number;
  unitSystem: UnitSystem;
  launchElevationM: number;
}

function nearestIdx(times: number[], target: number): number {
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < times.length; i++) {
    const d = Math.abs(times[i] - target);
    if (d < bestDiff) { bestDiff = d; best = i; }
  }
  return best;
}

export function TrajectoryPlot({
  trajectory,
  apogeeAgl,
  apogeeTimeS,
  burnOutTimeS,
  unitSystem,
  launchElevationM,
}: TrajectoryPlotProps) {
  const imp = unitSystem === 'imperial';
  const scale = imp ? M_FT : 1;
  const altUnit = imp ? 'ft' : 'm';

  const sx = trajectory.x.map(v => v * scale);
  const sy = trajectory.y.map(v => v * scale);
  // Subtract launch elevation to convert ASL → AGL
  const sz = trajectory.z.map(v => (v - launchElevationM) * scale);

  const burnoutIdx = nearestIdx(trajectory.t, burnOutTimeS);
  const apogeeIdx  = nearestIdx(trajectory.t, apogeeTimeS);
  const landingIdx = trajectory.t.length - 1;

  // Subsample to ≤200 animation frames
  const N = trajectory.t.length;
  const step = Math.max(1, Math.floor(N / 200));
  const animIdxs = Array.from({ length: Math.ceil(N / step) }, (_, i) => Math.min(i * step, N - 1));

  const frames: any[] = animIdxs.map((idx, fi) => ({
    name: String(fi),
    data: [{ x: [sx[idx]], y: [sy[idx]], z: [sz[idx]] }],
    traces: [1],
  }));

  const sliderSteps = animIdxs.map((idx, fi) => ({
    method: 'animate',
    label: fi % 20 === 0 ? `${trajectory.t[idx].toFixed(0)}s` : '',
    args: [[String(fi)], {
      frame: { duration: 0, redraw: true },
      mode: 'immediate',
      transition: { duration: 0 },
    }],
  }));

  const data: any[] = [
    // 0 — static path
    {
      type: 'scatter3d', mode: 'lines',
      x: sx, y: sy, z: sz,
      name: 'Flight path',
      line: { color: '#f87171', width: 3 },
      opacity: 0.5,
    },
    // 1 — animated rocket position
    {
      type: 'scatter3d', mode: 'markers',
      x: [sx[0]], y: [sy[0]], z: [sz[0]],
      name: 'Rocket',
      marker: { color: '#facc15', size: 10, symbol: 'circle' },
    },
    // static event markers
    { type: 'scatter3d', mode: 'markers', x: [sx[0]],            y: [sy[0]],            z: [sz[0]],            name: 'Launch',  marker: { color: '#34d399', size: 8, symbol: 'diamond' } },
    { type: 'scatter3d', mode: 'markers', x: [sx[burnoutIdx]],   y: [sy[burnoutIdx]],   z: [sz[burnoutIdx]],   name: 'Burnout', marker: { color: '#fb923c', size: 8, symbol: 'diamond' } },
    { type: 'scatter3d', mode: 'markers', x: [sx[apogeeIdx]],    y: [sy[apogeeIdx]],    z: [sz[apogeeIdx]],    name: 'Apogee',  marker: { color: '#60a5fa', size: 12, symbol: 'diamond' } },
    { type: 'scatter3d', mode: 'markers', x: [sx[landingIdx]],   y: [sy[landingIdx]],   z: [sz[landingIdx]],   name: 'Landing', marker: { color: '#94a3b8', size: 8, symbol: 'diamond' } },
  ];

  const apogeeDisplay = imp
    ? `${Math.round(apogeeAgl * M_FT).toLocaleString()} ft`
    : `${Math.round(apogeeAgl).toLocaleString()} m`;

  const layout: any = {
    paper_bgcolor: '#111827',
    scene: {
      xaxis: { title: { text: `East (${altUnit})`, font: { color: '#d1d5db', size: 12 } }, gridcolor: '#374151', backgroundcolor: '#1f2937', color: '#9ca3af', tickfont: { size: 10 } },
      yaxis: { title: { text: `North (${altUnit})`, font: { color: '#d1d5db', size: 12 } }, gridcolor: '#374151', backgroundcolor: '#1f2937', color: '#9ca3af', tickfont: { size: 10 } },
      zaxis: { title: { text: `Altitude (${altUnit})`, font: { color: '#d1d5db', size: 12 } }, gridcolor: '#374151', backgroundcolor: '#1f2937', color: '#9ca3af', tickfont: { size: 10 } },
      bgcolor: '#1f2937',
      camera: { eye: { x: 1.5, y: 1.5, z: 0.8 } },
    },
    legend: {
      font: { color: '#e2e8f0' },
      bgcolor: 'rgba(0,0,0,0)',
      x: 0, y: 1,
    },
    margin: { t: 10, r: 0, b: 110, l: 0 },
    autosize: true,
    height: 520,
    updatemenus: [{
      type: 'buttons',
      showactive: false,
      x: 0.08,
      xanchor: 'right',
      y: -0.07,
      yanchor: 'top',
      direction: 'left',
      pad: { r: 8, t: 4 },
      buttons: [
        {
          label: 'Play',
          method: 'animate',
          args: [null, {
            fromcurrent: true,
            frame: { duration: 50, redraw: true },
            transition: { duration: 0 },
          }],
        },
        {
          label: 'Pause',
          method: 'animate',
          args: [[null], { mode: 'immediate', frame: { duration: 0, redraw: false } }],
        },
      ],
      font: { color: '#e2e8f0', size: 13 },
      bgcolor: '#374151',
      bordercolor: '#4b5563',
      borderwidth: 1,
    }],
    sliders: [{
      active: 0,
      currentvalue: {
        prefix: 't = ',
        suffix: ' s',
        xanchor: 'center',
        font: { color: '#9ca3af', size: 12 },
        visible: true,
      },
      transition: { duration: 0 },
      x: 0.1,
      len: 0.88,
      y: 0,
      yanchor: 'top',
      pad: { t: 30, b: 8 },
      steps: sliderSteps,
      font: { color: '#9ca3af', size: 9 },
      bgcolor: '#374151',
      bordercolor: '#4b5563',
      tickcolor: '#6b7280',
      activebgcolor: '#3b82f6',
    }],
  };

  return (
    <div className="bg-gray-900 rounded-xl p-4">
      <h2 className="text-sm font-semibold text-gray-300 mb-0.5 uppercase tracking-wide">3D Flight Trajectory</h2>
      <p className="text-gray-600 text-xs mb-3">
        Apogee {apogeeDisplay} AGL · altitude {altUnit} · press Play to animate
      </p>
      <Plot
        data={data}
        layout={layout}
        frames={frames}
        config={{ responsive: true, displayModeBar: true }}
        style={{ width: '100%' }}
        useResizeHandler
      />
    </div>
  );
}
