import PlotlyImport from 'react-plotly.js';
const Plot = (PlotlyImport as any).default ?? PlotlyImport;
import type { Trajectory3D } from '../types';

interface TrajectoryPlotProps {
  trajectory: Trajectory3D;
  apogeeAgl: number;
  apogeeTimeS: number;
  burnOutTimeS: number;
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
}: TrajectoryPlotProps) {
  const burnoutIdx = nearestIdx(trajectory.t, burnOutTimeS);
  const apogeeIdx = nearestIdx(trajectory.t, apogeeTimeS);
  const landingIdx = trajectory.t.length - 1;

  const data: any[] = [
    // Flight path
    {
      type: 'scatter3d',
      mode: 'lines',
      x: trajectory.x,
      y: trajectory.y,
      z: trajectory.z,
      name: 'Flight path',
      line: { color: '#f87171', width: 4 },
    },
    // Launch marker
    {
      type: 'scatter3d',
      mode: 'markers',
      x: [trajectory.x[0]],
      y: [trajectory.y[0]],
      z: [trajectory.z[0]],
      name: 'Launch',
      marker: { color: '#34d399', size: 10, symbol: 'diamond' },
    },
    // Burnout marker
    {
      type: 'scatter3d',
      mode: 'markers',
      x: [trajectory.x[burnoutIdx]],
      y: [trajectory.y[burnoutIdx]],
      z: [trajectory.z[burnoutIdx]],
      name: 'Burnout',
      marker: { color: '#fb923c', size: 10, symbol: 'diamond' },
    },
    // Apogee marker
    {
      type: 'scatter3d',
      mode: 'markers',
      x: [trajectory.x[apogeeIdx]],
      y: [trajectory.y[apogeeIdx]],
      z: [trajectory.z[apogeeIdx]],
      name: 'Apogee',
      marker: { color: '#60a5fa', size: 14, symbol: 'diamond' },
    },
    // Landing marker
    {
      type: 'scatter3d',
      mode: 'markers',
      x: [trajectory.x[landingIdx]],
      y: [trajectory.y[landingIdx]],
      z: [trajectory.z[landingIdx]],
      name: 'Landing',
      marker: { color: '#94a3b8', size: 10, symbol: 'diamond' },
    },
  ];

  const layout: any = {
    title: {
      text: `3D Flight Trajectory — Apogee: ${Math.round(apogeeAgl)}m AGL`,
      font: { color: '#e2e8f0', size: 16 },
    },
    paper_bgcolor: '#111827',
    scene: {
      xaxis: {
        title: 'East (m)',
        gridcolor: '#374151',
        backgroundcolor: '#1f2937',
        color: '#9ca3af',
      },
      yaxis: {
        title: 'North (m)',
        gridcolor: '#374151',
        backgroundcolor: '#1f2937',
        color: '#9ca3af',
      },
      zaxis: {
        title: 'Altitude (m)',
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
    <div className="bg-gray-900 rounded-xl p-6">
      <h2 className="text-xl font-bold mb-2 text-white">3D Flight Trajectory</h2>
      <p className="text-gray-400 text-sm mb-4">
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
