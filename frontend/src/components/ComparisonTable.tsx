import type { ORResults, RocketPyResults } from '../types';

interface ComparisonTableProps {
  orResults: ORResults;
  rocketPyResults: RocketPyResults;
}

interface MetricRow {
  name: string;
  orField: keyof ORResults;
  rocketPyField: keyof RocketPyResults;
  unit: string;
}

export function ComparisonTable({ orResults, rocketPyResults }: ComparisonTableProps) {
  const metrics: MetricRow[] = [
    { name: 'Apogee', orField: 'apogee_m_agl', rocketPyField: 'apogee_m_agl', unit: 'm AGL' },
    { name: 'Max Velocity', orField: 'max_velocity_ms', rocketPyField: 'max_speed_ms', unit: 'm/s' },
    { name: 'Max Mach', orField: 'max_mach', rocketPyField: 'max_mach', unit: '—' },
    { name: 'Time to Apogee', orField: 'time_to_apogee_s', rocketPyField: 'apogee_time_s', unit: 's' },
    { name: 'Velocity Off Rail', orField: 'velocity_off_rail_ms', rocketPyField: 'out_of_rail_velocity', unit: 'm/s' },
    { name: 'Stability Margin', orField: 'stability_margin_cal', rocketPyField: 'static_margin_cal', unit: 'cal' },
    { name: 'Max Acceleration', orField: 'max_acceleration_ms2', rocketPyField: 'max_acceleration_ms2', unit: 'm/s²' },
  ];

  const formatNumber = (val: number | undefined): string => {
    if (val === undefined || val === null) return 'N/A';
    return val.toFixed(2);
  };

  const calculateDelta = (orVal: number | undefined, rocketPyVal: number): number | null => {
    if (orVal === undefined || orVal === null || orVal === 0) return null;
    return ((rocketPyVal - orVal) / orVal) * 100;
  };

  const getDeltaColor = (delta: number | null): string => {
    if (delta === null) return 'text-gray-500';
    const absDelta = Math.abs(delta);
    if (absDelta <= 5) return 'text-green-400';
    if (absDelta <= 15) return 'text-yellow-400';
    return 'text-red-400';
  };

  const formatDelta = (delta: number | null): string => {
    if (delta === null) return 'N/A';
    const sign = delta >= 0 ? '+' : '';
    return `${sign}${delta.toFixed(1)}%`;
  };

  return (
    <div className="bg-gray-900 rounded-xl p-6">
      <h2 className="text-xl font-bold mb-4">Simulation Comparison</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-800 text-gray-400 text-sm uppercase border-b border-gray-700">
              <th className="px-4 py-3 text-left font-semibold">Metric</th>
              <th className="px-4 py-3 text-right font-semibold">OpenRocket</th>
              <th className="px-4 py-3 text-right font-semibold">RocketPy</th>
              <th className="px-4 py-3 text-right font-semibold">Delta</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-700">
            {metrics.map((metric, idx) => {
              const orVal = orResults[metric.orField] as number | undefined;
              const rocketPyVal = rocketPyResults[metric.rocketPyField] as number;
              const delta = calculateDelta(orVal, rocketPyVal);
              const deltaColor = getDeltaColor(delta);
              const isApogee = idx === 0;

              return (
                <tr key={metric.name} className="hover:bg-gray-800 transition-colors">
                  <td className={`px-4 py-3 text-left font-${isApogee ? 'semibold' : 'normal'} ${isApogee ? 'text-base' : 'text-sm'} text-white`}>
                    {metric.name} <span className="text-gray-400 font-normal ml-1">({metric.unit})</span>
                  </td>
                  <td className={`px-4 py-3 text-right font-mono ${orVal === undefined ? 'text-gray-500' : 'text-gray-200'}`}>
                    {formatNumber(orVal)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-gray-200">
                    {formatNumber(rocketPyVal)}
                  </td>
                  <td className={`px-4 py-3 text-right font-mono font-semibold ${deltaColor}`}>
                    {formatDelta(delta)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-gray-500 text-sm mt-4">
        OpenRocket typically overpredicts apogee by 10–30% vs RocketPy. Large deltas on apogee are expected.
      </p>
    </div>
  );
}
