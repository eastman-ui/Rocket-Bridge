import type { ORResults, RocketPyResults } from '../types';
import type { UnitSystem, StabilityUnit } from './TimeSeriesCharts';

interface ComparisonTableProps {
  orResults: ORResults;
  rocketPyResults: RocketPyResults;
  unitSystem: UnitSystem;
  stabilityUnit: StabilityUnit;
}

const M_TO_FT = 3.28084;
const MS_TO_FTS = 3.28084;

interface MetricRow {
  name: string;
  orVal: number | undefined;
  rocketPyVal: number;
  unit: string;
}

export function ComparisonTable({ orResults, rocketPyResults, unitSystem, stabilityUnit }: ComparisonTableProps) {
  const imp = unitSystem === 'imperial';

  const conv = (v: number | undefined | null, factor: number): number | undefined =>
    v != null ? v * factor : undefined;

  const altFactor = imp ? M_TO_FT : 1;
  const velFactor = imp ? MS_TO_FTS : 1;
  const accFactor = imp ? M_TO_FT : 1;

  const altUnit = imp ? 'ft AGL' : 'm AGL';
  const velUnit = imp ? 'ft/s' : 'm/s';
  const accUnit = imp ? 'ft/s²' : 'm/s²';

  const stabVal = (cal: number | undefined, pct: number | undefined) =>
    stabilityUnit === 'pct' ? pct : cal;
  const stabUnit = stabilityUnit === 'pct' ? '%' : 'cal';

  const metrics: MetricRow[] = [
    {
      name: 'Apogee',
      orVal: conv(orResults.apogee_m_agl, altFactor),
      rocketPyVal: rocketPyResults.apogee_m_agl * altFactor,
      unit: altUnit,
    },
    {
      name: 'Max Velocity',
      orVal: conv(orResults.max_velocity_ms, velFactor),
      rocketPyVal: rocketPyResults.max_speed_ms * velFactor,
      unit: velUnit,
    },
    {
      name: 'Max Mach',
      orVal: orResults.max_mach,
      rocketPyVal: rocketPyResults.max_mach,
      unit: '—',
    },
    {
      name: 'Time to Apogee',
      orVal: orResults.time_to_apogee_s,
      rocketPyVal: rocketPyResults.apogee_time_s,
      unit: 's',
    },
    {
      name: 'Velocity Off Rail',
      orVal: conv(orResults.velocity_off_rail_ms, velFactor),
      rocketPyVal: rocketPyResults.out_of_rail_velocity * velFactor,
      unit: velUnit,
    },
    {
      name: 'Stability Margin',
      orVal: stabVal(orResults.stability_margin_cal, undefined),
      rocketPyVal: stabVal(rocketPyResults.static_margin_cal, rocketPyResults.static_margin_pct) ?? 0,
      unit: stabUnit,
    },
    {
      name: 'Max Acceleration',
      orVal: conv(orResults.max_acceleration_ms2, accFactor),
      rocketPyVal: rocketPyResults.max_acceleration_ms2 * accFactor,
      unit: accUnit,
    },
  ];

  const fmt = (val: number | undefined): string => {
    if (val === undefined || val === null) return 'N/A';
    return val.toFixed(2);
  };

  const delta = (orVal: number | undefined, rpyVal: number): number | null => {
    if (!orVal) return null;
    return ((rpyVal - orVal) / orVal) * 100;
  };

  const deltaColor = (d: number | null) => {
    if (d === null) return 'text-gray-500';
    return Math.abs(d) <= 5 ? 'text-green-400' : Math.abs(d) <= 15 ? 'text-yellow-400' : 'text-red-400';
  };

  const fmtDelta = (d: number | null) => {
    if (d === null) return '—';
    return `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`;
  };

  return (
    <div className="bg-gray-900 rounded-xl p-4">
      <h2 className="text-sm font-semibold text-gray-300 mb-3 uppercase tracking-wide">Simulation Comparison</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-500 text-xs uppercase border-b border-gray-700">
              <th className="pb-2 text-left font-semibold">Metric</th>
              <th className="pb-2 px-3 text-right font-semibold">OpenRocket</th>
              <th className="pb-2 px-3 text-right font-semibold">RocketPy</th>
              <th className="pb-2 text-right font-semibold">Δ</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {metrics.map((m) => {
              const d = delta(m.orVal, m.rocketPyVal);
              return (
                <tr key={m.name} className="hover:bg-gray-800/50 transition-colors">
                  <td className="py-1.5 text-left text-gray-300">
                    {m.name}
                    <span className="text-gray-600 text-xs ml-1">({m.unit})</span>
                  </td>
                  <td className={`py-1.5 px-3 text-right font-mono text-xs ${m.orVal === undefined ? 'text-gray-600' : 'text-gray-300'}`}>
                    {fmt(m.orVal)}
                  </td>
                  <td className="py-1.5 px-3 text-right font-mono text-xs text-gray-200">{fmt(m.rocketPyVal)}</td>
                  <td className={`py-1.5 text-right font-mono text-xs font-semibold ${deltaColor(d)}`}>{fmtDelta(d)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
