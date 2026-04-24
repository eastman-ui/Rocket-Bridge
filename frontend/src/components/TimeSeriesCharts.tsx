import Plot from 'react-plotly.js';
import type { TimeSeriesData } from '../types';

interface TimeSeriesChartsProps {
  orTimeseries: TimeSeriesData | undefined;
  rocketPyTimeseries: TimeSeriesData;
}

export function TimeSeriesCharts({ orTimeseries, rocketPyTimeseries }: TimeSeriesChartsProps) {
  const layout = (title: string, yLabel: string, shapes?: object[]) => ({
    title: { text: title, font: { color: '#e2e8f0', size: 14 } },
    paper_bgcolor: '#111827',
    plot_bgcolor: '#1f2937',
    font: { color: '#9ca3af' },
    xaxis: { title: 'Time (s)', gridcolor: '#374151', zerolinecolor: '#4b5563' },
    yaxis: { title: yLabel, gridcolor: '#374151', zerolinecolor: '#4b5563' },
    legend: { font: { color: '#e2e8f0' }, bgcolor: 'rgba(0,0,0,0)' },
    margin: { t: 45, r: 15, b: 45, l: 60 },
    autosize: true,
    shapes: shapes ?? [],
  });

  const config = { responsive: true, displayModeBar: false };

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
    type: 'scatter',
    mode: 'lines',
    name,
    line: { color: '#f87171', width: 2 },
  });

  const machRefLine = {
    type: 'line',
    x0: 0,
    x1: 1,
    xref: 'paper',
    y0: 1,
    y1: 1,
    line: { color: '#94a3b8', dash: 'dash', width: 1 },
  };

  const stabilityLine1 = {
    type: 'line',
    x0: 0,
    x1: 1,
    xref: 'paper',
    y0: 1.5,
    y1: 1.5,
    line: { color: '#fbbf24', dash: 'dash', width: 1 },
  };

  const stabilityLine2 = {
    type: 'line',
    x0: 0,
    x1: 1,
    xref: 'paper',
    y0: 2.5,
    y1: 2.5,
    line: { color: '#34d399', dash: 'dash', width: 1 },
  };

  const altitudeData = [
    ...(orTimeseries ? [orTrace(orTimeseries.altitude)] : []),
    rpyTrace(rocketPyTimeseries.altitude),
  ];

  const velocityData = [
    ...(orTimeseries ? [orTrace(orTimeseries.velocity)] : []),
    rpyTrace(rocketPyTimeseries.velocity),
  ];

  const machData = [
    ...(orTimeseries ? [orTrace(orTimeseries.mach)] : []),
    rpyTrace(rocketPyTimeseries.mach),
  ];

  const stabilityData = [
    ...(orTimeseries ? [orTrace(orTimeseries.stability)] : []),
    rpyTrace(rocketPyTimeseries.stability),
  ];

  const thrustData = [
    {
      x: rocketPyTimeseries.time,
      y: rocketPyTimeseries.thrust,
      type: 'scatter',
      mode: 'lines',
      name: 'RocketPy',
      line: { color: '#fb923c', width: 2 },
      fill: 'tozeroy',
      fillcolor: 'rgba(251,146,60,0.15)',
    },
  ];

  return (
    <div className="bg-gray-900 rounded-xl p-6">
      <h2 className="text-xl font-bold mb-4 text-white">Flight Data</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Chart 1: Altitude */}
        <div className="w-full">
          <Plot
            data={altitudeData as any}
            layout={layout('Altitude', 'Altitude (m AGL)') as any}
            config={config}
            style={{ width: '100%', height: '300px' }}
            useResizeHandler
          />
        </div>

        {/* Chart 2: Velocity */}
        <div className="w-full">
          <Plot
            data={velocityData as any}
            layout={layout('Velocity', 'Velocity (m/s)') as any}
            config={config}
            style={{ width: '100%', height: '300px' }}
            useResizeHandler
          />
        </div>

        {/* Chart 3: Mach */}
        <div className="w-full">
          <Plot
            data={machData as any}
            layout={layout('Mach Number', 'Mach Number', [machRefLine]) as any}
            config={config}
            style={{ width: '100%', height: '300px' }}
            useResizeHandler
          />
        </div>

        {/* Chart 4: Stability Margin */}
        <div className="w-full">
          <Plot
            data={stabilityData as any}
            layout={layout('Stability Margin', 'Stability (cal)', [stabilityLine1, stabilityLine2]) as any}
            config={config}
            style={{ width: '100%', height: '300px' }}
            useResizeHandler
          />
        </div>

        {/* Chart 5: Thrust — full width */}
        <div className="md:col-span-2 w-full">
          <Plot
            data={thrustData as any}
            layout={layout('Thrust', 'Thrust (N)') as any}
            config={config}
            style={{ width: '100%', height: '300px' }}
            useResizeHandler
          />
        </div>
      </div>
    </div>
  );
}
