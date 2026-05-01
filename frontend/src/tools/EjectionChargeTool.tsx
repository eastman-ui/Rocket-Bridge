import { useState, useMemo } from 'react';

const R_GAS = 8.314;   // J/(mol·K)
const T_AMB = 293;     // K (20°C)
const M_BP = 0.1294;   // kg/mol — effective molar mass of FFFG combustion gas products (back-derived from Apogee empirical formula)
const BACKUP_FACTOR = 1.2;

function calcCharge(
  idIn: number,
  lenIn: number,
  psiTarget: number
): { primary: number; backup: number; volumeIn3: number } | null {
  if (!Number.isFinite(idIn) || idIn <= 0 ||
      !Number.isFinite(lenIn) || lenIn <= 0 ||
      !Number.isFinite(psiTarget) || psiTarget <= 0) return null;
  const r = idIn / 2;
  const volumeIn3 = Math.PI * r * r * lenIn;
  const volumeM3 = volumeIn3 * 1.6387e-5;        // 1 in³ = 1.6387e-5 m³
  const pressurePa = psiTarget * 6894.76;         // 1 PSI = 6894.76 Pa
  const moles = (pressurePa * volumeM3) / (R_GAS * T_AMB);
  const primary = moles * M_BP * 1000;            // grams
  return { primary, backup: primary * BACKUP_FACTOR, volumeIn3 };
}

interface CompartmentProps {
  label: string;
  psi: number;
}

function Compartment({ label, psi }: CompartmentProps) {
  const [id, setId] = useState('');
  const [len, setLen] = useState('');

  const result = useMemo(() => {
    const idN = parseFloat(id);
    const lenN = parseFloat(len);
    return calcCharge(idN, lenN, psi);
  }, [id, len, psi]);

  return (
    <div className="border border-gray-800 rounded-xl p-4 space-y-3">
      <h4 className="text-xs font-semibold text-gray-300 uppercase tracking-wide">{label}</h4>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-400">
            Inner diameter <span className="text-gray-600">in</span>
          </label>
          <input
            type="number" step="0.1" min="0" value={id}
            onChange={e => setId(e.target.value)}
            placeholder="e.g. 3.9"
            className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:border-blue-500"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-400">
            Tube length <span className="text-gray-600">in</span>
          </label>
          <input
            type="number" step="0.5" min="0" value={len}
            onChange={e => setLen(e.target.value)}
            placeholder="motor → bulkhead"
            className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:border-blue-500"
          />
        </div>
      </div>

      {result ? (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-gray-950 border border-gray-800 rounded-lg p-3 text-center">
              <p className="text-[10px] text-gray-500 uppercase mb-1">Primary</p>
              <p className="text-green-400 text-xl font-mono font-bold">{result.primary.toFixed(1)} g</p>
              <p className="text-[10px] text-gray-600">black powder</p>
            </div>
            <div className="bg-gray-950 border border-gray-800 rounded-lg p-3 text-center">
              <p className="text-[10px] text-gray-500 uppercase mb-1">Backup (+20%)</p>
              <p className="text-amber-400 text-xl font-mono font-bold">{result.backup.toFixed(1)} g</p>
              <p className="text-[10px] text-gray-600">black powder</p>
            </div>
          </div>
          <p className="text-[10px] text-gray-600">
            Tube vol: {result.volumeIn3.toFixed(1)} in³ · P·V = n·R·T · FFFG assumed
          </p>
        </div>
      ) : (
        <p className="text-xs text-gray-600 italic">Enter dimensions to calculate</p>
      )}
    </div>
  );
}

export function EjectionChargeTool() {
  const [psi, setPsi] = useState(15);

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-gray-200 uppercase tracking-wide">
        Ejection Charge Calculator
      </h3>
      <p className="text-xs text-gray-500">
        Calculates FFFG black powder mass for tube pressurization using P·V = n·R·T.
        Backup charge is primary × 1.2. Always in inches / PSI (HPR convention).
      </p>

      <div className="flex items-center gap-3">
        <label className="text-xs text-gray-400 whitespace-nowrap">
          Target deployment pressure
        </label>
        <input
          type="number" step="1" min="5" max="30" value={psi}
          onChange={e => setPsi(parseFloat(e.target.value) || 15)}
          className="w-20 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:border-blue-500"
        />
        <span className="text-xs text-gray-600">PSI (applies to both compartments)</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Compartment label="Drogue / Primary compartment" psi={psi} />
        <Compartment label="Main chute compartment" psi={psi} />
      </div>
    </div>
  );
}
