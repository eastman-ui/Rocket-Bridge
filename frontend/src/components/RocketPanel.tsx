import type { ReactNode } from 'react';
import type { RocketParams } from '../types';
import type { UnitSystem } from './TimeSeriesCharts';

interface RocketPanelProps {
  params: RocketParams;
  diagram?: string;
  weatherSource?: string;
  unitSystem: UnitSystem;
  isOpen: boolean;
  onClose: () => void;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-baseline py-2 border-b border-gray-800 last:border-0">
      <span className="text-gray-400 text-sm">{label}</span>
      <span className="text-white text-sm font-medium tabular-nums">{value}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-4">
      <p className="text-xs text-gray-500 uppercase tracking-wide font-semibold mb-1">{title}</p>
      {children}
    </div>
  );
}

const M_FT = 3.28084;
const KG_LB = 2.20462;
const CM_IN = 0.393701;

export function RocketPanel({ params, diagram, weatherSource, unitSystem, isOpen, onClose }: RocketPanelProps) {
  const imp = unitSystem === 'imperial';

  const fmtLen = (m: number) =>
    imp ? `${(m * M_FT).toFixed(2)} ft` : `${m.toFixed(2)} m`;
  const fmtDiam = (m: number) =>
    imp ? `${(m * 100 * CM_IN).toFixed(2)} in` : `${(m * 100).toFixed(1)} cm`;
  const fmtMass = (kg: number) =>
    imp ? `${(kg * KG_LB).toFixed(2)} lb` : `${kg.toFixed(2)} kg`;

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/60 z-40 transition-opacity duration-200 ${
          isOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        onClick={onClose}
      />
      <div
        className={`fixed right-0 top-0 h-full w-72 bg-gray-900 border-l border-gray-700 z-50 overflow-y-auto transition-transform duration-200 ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 sticky top-0 bg-gray-900 z-10">
          <h3 className="font-semibold text-white text-sm">Rocket Details</h3>
          <button
            onClick={onClose}
            aria-label="Close panel"
            className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:text-white hover:bg-gray-700 transition-colors text-lg leading-none"
          >
            ×
          </button>
        </div>

        {diagram ? (
          <div className="p-3 border-b border-gray-800 bg-gray-950">
            <img
              src={`data:image/png;base64,${diagram}`}
              alt="Rocket cross-section diagram"
              className="w-full rounded"
            />
          </div>
        ) : (
          <div className="p-4 border-b border-gray-800 text-center text-gray-600 text-xs">
            Diagram not available
          </div>
        )}

        <div className="px-4 pb-6">
          <Section title="Propulsion">
            {params.motor_designation && (
              <Row label="Motor" value={params.motor_designation} />
            )}
          </Section>

          <Section title="Geometry">
            {params.length_m > 0 && (
              <Row label="Length" value={fmtLen(params.length_m)} />
            )}
            {params.diameter_m > 0 && (
              <Row label="Diameter" value={fmtDiam(params.diameter_m)} />
            )}
          </Section>

          <Section title="Mass">
            <Row label="Wet mass" value={fmtMass(params.wet_mass_kg)} />
            <Row label="Dry mass" value={fmtMass(params.dry_mass_kg)} />
            <Row label="Propellant" value={fmtMass(params.propellant_mass_kg)} />
            <Row label="Motor casing" value={fmtMass(params.motor_dry_mass_kg)} />
          </Section>

          <Section title="Configuration">
            <Row label="Fins" value={`${params.fin_count}`} />
            <Row label="Parachutes" value={`${params.parachute_count}`} />
            {weatherSource && (
              <Row
                label="Weather"
                value={weatherSource === 'standard_atmosphere' ? 'Std Atmosphere' : weatherSource}
              />
            )}
          </Section>
        </div>
      </div>
    </>
  );
}
