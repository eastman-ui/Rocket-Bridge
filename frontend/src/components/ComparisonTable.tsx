import type { ORResults, RocketPyResults } from '../types';
import type { UnitSystem, StabilityUnit } from './TimeSeriesCharts';

interface ComparisonTableProps {
  orResults: ORResults;
  rocketPyResults: RocketPyResults;
  unitSystem: UnitSystem;
  stabilityUnit: StabilityUnit;
  className?: string;
}

const M_TO_FT = 3.28084;
const MS_TO_FTS = 3.28084;
const N_TO_LBF = 0.224809;

interface MetricRow {
  name: string;
  orVal: number | undefined;
  rocketPyVal: number;
  unit: string;
  decimals?: number;
  tooltip?: string;
}

function InfoTooltip({ text }: { text: string }) {
  return (
    <span className="relative group inline-flex items-center ml-1 align-middle">
      <svg className="w-3 h-3 text-gray-600 group-hover:text-gray-400 cursor-help transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <circle cx="12" cy="12" r="10" />
        <path strokeLinecap="round" d="M12 16v-4M12 8h.01" />
      </svg>
      <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 text-xs bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-2 text-gray-300 invisible group-hover:visible z-20 shadow-xl leading-relaxed whitespace-normal">
        {text}
      </span>
    </span>
  );
}

export function ComparisonTable({ orResults, rocketPyResults, unitSystem, stabilityUnit, className = '' }: ComparisonTableProps) {
  const imp = unitSystem === 'imperial';

  const conv = (v: number | undefined | null, factor: number): number | undefined =>
    v != null ? v * factor : undefined;

  const altFactor = imp ? M_TO_FT : 1;
  const velFactor = imp ? MS_TO_FTS : 1;
  const accFactor = imp ? M_TO_FT : 1;
  const forceFactor = imp ? N_TO_LBF : 1;

  const altUnit = imp ? 'ft AGL' : 'm AGL';
  const velUnit = imp ? 'ft/s' : 'm/s';
  const accUnit = imp ? 'ft/s²' : 'm/s²';
  const forceUnit = imp ? 'lbf' : 'N';
  const distUnit = imp ? 'ft' : 'm';

  const stabVal = (cal: number | undefined, pct: number | undefined) =>
    stabilityUnit === 'pct' ? pct : cal;
  const stabUnit = stabilityUnit === 'pct' ? '%' : 'cal';

  // Derived stats from timeseries
  const orThrust = orResults.timeseries?.thrust ?? [];
  const rpyThrust = rocketPyResults.timeseries.thrust;
  const orTime = orResults.timeseries?.time ?? [];
  const rpyTime = rocketPyResults.timeseries.time;

  const orMaxThrust = orThrust.length ? Math.max(...orThrust) : undefined;
  const rpyMaxThrust = rpyThrust.length ? Math.max(...rpyThrust) : 0;

  const orFlightTime = orTime.length ? orTime[orTime.length - 1] : undefined;
  const rpyFlightTime = rpyTime.length ? rpyTime[rpyTime.length - 1] : 0;

  // OR burn time: last t where thrust > threshold
  const orBurnTime = (() => {
    for (let i = orThrust.length - 1; i >= 0; i--) {
      if (orThrust[i] > 0.5) return orTime[i];
    }
    return undefined;
  })();

  // Drift distance from launch to landing (RocketPy only — OR has no 2D trajectory)
  const { x, y } = rocketPyResults.trajectory_3d;
  const landingI = x.length - 1;
  const driftM = Math.sqrt(x[landingI] ** 2 + y[landingI] ** 2);

  // Max altitude ASL (RocketPy) / estimate for OR using site elevation
  const rpyApogeeAsl = rocketPyResults.apogee_m_asl;
  // OR doesn't directly give ASL; show RocketPy only (no site elev available here)

  // Coast time = apogee_time - burn_out_time
  const rpyCoastTime = rocketPyResults.apogee_time_s - rocketPyResults.burn_out_time_s;

  const metrics: MetricRow[] = [
    {
      name: 'Apogee',
      orVal: conv(orResults.apogee_m_agl, altFactor),
      rocketPyVal: rocketPyResults.apogee_m_agl * altFactor,
      unit: altUnit,
      decimals: 0,
    },
    {
      name: 'Apogee ASL',
      orVal: undefined,
      rocketPyVal: rpyApogeeAsl * altFactor,
      unit: imp ? 'ft ASL' : 'm ASL',
      decimals: 0,
    },
    {
      name: 'Max Velocity',
      orVal: conv(orResults.max_velocity_ms, velFactor),
      rocketPyVal: rocketPyResults.max_speed_ms * velFactor,
      unit: velUnit,
      decimals: 1,
    },
    {
      name: 'Max Mach',
      orVal: orResults.max_mach,
      rocketPyVal: rocketPyResults.max_mach,
      unit: '—',
      decimals: 3,
    },
    {
      name: 'Max Acceleration',
      orVal: conv(orResults.max_acceleration_ms2, accFactor),
      rocketPyVal: rocketPyResults.max_acceleration_ms2 * accFactor,
      unit: accUnit,
      decimals: 1,
    },
    {
      name: 'Max Thrust',
      orVal: orMaxThrust != null ? orMaxThrust * forceFactor : undefined,
      rocketPyVal: rpyMaxThrust * forceFactor,
      unit: forceUnit,
      decimals: 0,
    },
    {
      name: 'Velocity Off Rail',
      orVal: conv(orResults.velocity_off_rail_ms, velFactor),
      rocketPyVal: rocketPyResults.out_of_rail_velocity * velFactor,
      unit: velUnit,
      decimals: 1,
    },
    {
      name: 'Stability Margin',
      orVal: stabVal(orResults.stability_margin_cal, undefined),
      rocketPyVal: stabVal(rocketPyResults.static_margin_cal, rocketPyResults.static_margin_pct) ?? 0,
      unit: stabUnit,
      decimals: 2,
      tooltip: 'OR and RocketPy use different Barrowman implementations with different correction factors, so stability margins commonly diverge. OR reports stability at the first simulation timestep; RocketPy reports at rail departure.',
    },
    {
      name: 'Burn Time',
      orVal: orBurnTime,
      rocketPyVal: rocketPyResults.burn_out_time_s,
      unit: 's',
      decimals: 2,
    },
    {
      name: 'Coast Time',
      orVal: undefined,
      rocketPyVal: rpyCoastTime,
      unit: 's',
      decimals: 1,
    },
    {
      name: 'Time to Apogee',
      orVal: orResults.time_to_apogee_s,
      rocketPyVal: rocketPyResults.apogee_time_s,
      unit: 's',
      decimals: 1,
    },
    {
      name: 'Total Flight Time',
      orVal: orFlightTime,
      rocketPyVal: rpyFlightTime,
      unit: 's',
      decimals: 1,
    },
    {
      name: 'Drift Distance',
      orVal: undefined,
      rocketPyVal: driftM * altFactor,
      unit: distUnit,
      decimals: 0,
    },
  ];

  const fmt = (val: number | undefined, decimals = 2): string => {
    if (val === undefined || val === null) return 'N/A';
    return val >= 1000
      ? val.toLocaleString('en-US', { maximumFractionDigits: decimals })
      : val.toFixed(decimals);
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
    <div className={`bg-gray-900 rounded-xl p-4 flex flex-col ${className}`}>
      <h2 className="text-sm font-semibold text-gray-300 mb-2 uppercase tracking-wide shrink-0">Simulation Comparison</h2>
      <div className="flex-1 overflow-x-auto">
        <table className="w-full text-sm h-full">
          <thead>
            <tr className="text-gray-500 text-xs uppercase border-b border-gray-700">
              <th className="pb-1.5 text-left font-semibold">Metric</th>
              <th className="pb-1.5 px-5 text-right font-semibold">OpenRocket</th>
              <th className="pb-1.5 px-5 text-right font-semibold">RocketPy</th>
              <th className="pb-1.5 pl-5 text-right font-semibold">Δ</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => {
              const d = delta(m.orVal, m.rocketPyVal);
              return (
                <tr key={m.name} className="hover:bg-gray-800/50 transition-colors border-b border-gray-800/60">
                  <td className="py-1 text-left text-gray-300 text-xs">
                    {m.name}
                    <span className="text-gray-600 ml-1">({m.unit})</span>
                    {m.tooltip && <InfoTooltip text={m.tooltip} />}
                  </td>
                  <td className={`py-1 px-5 text-right font-mono text-xs ${m.orVal === undefined ? 'text-gray-600' : 'text-gray-300'}`}>
                    {fmt(m.orVal, m.decimals)}
                  </td>
                  <td className="py-1 px-5 text-right font-mono text-xs text-gray-200">{fmt(m.rocketPyVal, m.decimals)}</td>
                  <td className={`py-1 pl-5 text-right font-mono text-xs font-semibold ${deltaColor(d)}`}>{fmtDelta(d)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
