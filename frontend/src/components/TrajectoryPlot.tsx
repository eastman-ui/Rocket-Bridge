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
}

function nearestIdx(times: number[], target: number): number {
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < times.length; i++) {
    const d = Math.abs(times[i] - target);
    if (d < bestDiff) {
      bestDiff = d;
      best = i;
    }
  }
  return best;
}

export function TrajectoryPlot({
  trajectory,
  apogeeAgl,
  apogeeTimeS,
  burnOutTimeS,
  unitSystem,
}: TrajectoryPlotProps) {
  const imp = unitSystem === 'imperial';
  const scale = imp ? M_FT : 1;
  const altUnit = imp ? 'ft' : 'm';

  const sx = trajectory.x.map(v => v * scale);
  const sy = trajectory.y.map(v => v * scale);
  const sz = trajectory.z.map(v => v * scale);

  const burnoutIdx = nearestIdx(trajectory.t, burnOutTimeS);
  const apogeeIdx = nearestIdx(trajectory.t, apogeeTimeS);
  const landingIdx = trajectory.t.length - 1;

  // Orientation cones — ~20 evenly-spaced markers showing nose direction
  const hasOrientation = trajectory.ux && trajectory.ux.length === trajectory.t.length;
  const coneStep = hasOrientation ? Math.max(1, Math.floor(trajectory.t.length / 20)) : 1;
  const coneIdxs = hasOrientation
    ? Array.from({ length: Math.ceil(trajectory.t.length / coneStep) }, (_, i) => i * coneStep)
        .filter(i => i < trajectory.t.length)
    : [];
  const coneSize = apogeeAgl * scale * 0.04;

  const data: any[] = [
    // Flight path
    {
      type: 'scatter3d',
      mode: 'lines',
      x: sx,
      y: sy,
      z: sz,
      name: 'Flight path',
      line: { color: '#f87171', width: 4 },
    },
    // Nose orientation cones
    ...(hasOrientation && coneIdxs.length > 0 ? [{
      type: 'cone',
      x: coneIdxs.map(i => sx[i]),
      y: coneIdxs.map(i => sy[i]),
      z: coneIdxs.map(i => sz[i]),
      u: coneIdxs.map(i => trajectory.ux![i]),
      v: coneIdxs.map(i => trajectory.uy![i]),
      w: coneIdxs.map(i => trajectory.uz![i]),
      sizemode: 'absolute',
      sizeref: coneSize,
      colorscale: [[0, '#60a5fa'], [1, '#fb923c']],
      showscale: false,
      name: 'Orientation',
      hovertemplate: 't=%{customdata:.1f}s<extra>Orientation</extra>',
      customdata: coneIdxs.map(i => trajectory.t[i]),
    }] : []),
    // Launch marker
    {
      type: 'scatter3d',
      mode: 'markers',
      x: [sx[0]],
      y: [sy[0]],
      z: [sz[0]],
      name: 'Launch',
      marker: { color: '#34d399', size: 10, symbol: 'diamond' },
    },
    // Burnout marker
    {
      type: 'scatter3d',
      mode: 'markers',
      x: [sx[burnoutIdx]],
      y: [sy[burnoutIdx]],
      z: [sz[burnoutIdx]],
      name: 'Burnout',
      marker: { color: '#fb923c', size: 10, symbol: 'diamond' },
    },
    // Apogee marker
    {
      type: 'scatter3d',
      mode: 'markers',
      x: [sx[apogeeIdx]],
      y: [sy[apogeeIdx]],
      z: [sz[apogeeIdx]],
      name: 'Apogee',
      marker: { color: '#60a5fa', size: 14, symbol: 'diamond' },
    },
    // Landing marker
    {
      type: 'scatter3d',
      mode: 'markers',
      x: [sx[landingIdx]],
      y: [sy[landingIdx]],
      z: [sz[landingIdx]],
      name: 'Landing',
      marker: { color: '#94a3b8', size: 10, symbol: 'diamond' },
    },
  ];

  const apogeeDisplay = imp
    ? `${Math.round(apogeeAgl * M_FT).toLocaleString()} ft`
    : `${Math.round(apogeeAgl).toLocaleString()} m`;

  const layout: any = {
    title: {
      text: `3D Flight Trajectory — Apogee: ${apogeeDisplay} AGL`,
      font: { color: '#e2e8f0', size: 16 },
    },
    paper_bgcolor: '#111827',
    scene: {
      xaxis: {
        title: `East (${altUnit})`,
        gridcolor: '#374151',
        backgroundcolor: '#1f2937',
        color: '#9ca3af',
      },
      yaxis: {
        title: `North (${altUnit})`,
        gridcolor: '#374151',
        backgroundcolor: '#1f2937',
        color: '#9ca3af',
      },
      zaxis: {
        title: `Altitude (${altUnit})`,
        gridcolor: '#374151',
        backgroundcolor: '#1f2937',
        color: '#9ca3af',
      },
      bgcolor: '#1f2937',
      camera: { eye: { x: 1.5, y: 1.5, z: 0.8 } },
    },
    legend: {
      font: { color: '#e2e8f0' },
      bgcolor: 'rgba(0,0,0,0)',
      x: 0,
      y: 1,
    },
    margin: { t: 60, r: 0, b: 0, l: 0 },
    autosize: true,
    height: 500,
  };

  return (
    <div className="bg-gray-900 rounded-xl p-4">
      <h2 className="text-sm font-semibold text-gray-300 mb-1 uppercase tracking-wide">3D Flight Trajectory</h2>
      <p className="text-gray-600 text-xs mb-3">
        Coordinate system: East/North from launch point. Altitude in meters.
      </p>
      <Plot
        data={data}
        layout={layout}
        config={{ responsive: true, displayModeBar: true }}
        style={{ width: '100%' }}
        useResizeHandler
      />
    </div>
  );
}
