import { useState, useEffect, useRef, useMemo } from 'react';
import type { ComparisonResponse } from '../types';

interface Props {
  result: ComparisonResponse;
  unitSystem: 'imperial' | 'metric';
}

// SVG coordinate constants
const SVG_X0 = 60;   // nose tip x
const SVG_X1 = 540;  // nozzle trailing edge x
const SVG_W = SVG_X1 - SVG_X0;  // 480 px — full rocket length span

// CP placed at 65% of rocket length from nose (normalized approximation)
const CP_NORM = 0.65;

// Animation: 1 real second = 2 sim seconds
const SIM_SPEED = 2.0;

export function CGCPAnimationTool({ result, unitSystem }: Props) {
  const rpy = result.rocketpy_results;
  const params = result.rocket_params;
  const ts = rpy.timeseries;

  const burnEnd = rpy.burn_out_time_s;
  const imp = unitSystem === 'imperial';
  const stabArray = ts.stability;

  // Last index within the burn window
  const burnIdxEnd = useMemo(() => {
    let idx = ts.time.length - 1;
    for (let i = ts.time.length - 1; i >= 0; i--) {
      if (ts.time[i] <= burnEnd) { idx = i; break; }
    }
    return idx;
  }, [ts.time, burnEnd]);

  const minStability = useMemo(
    () => stabArray.slice(0, burnIdxEnd + 1).reduce((m, v) => (Number.isFinite(v) && v < m ? v : m), Infinity),
    [stabArray, burnIdxEnd]
  );

  const [timeIdx, setTimeIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const rafRef = useRef<number | null>(null);
  const lastRealTime = useRef<number | null>(null);
  const tsTimeRef = useRef(ts.time);
  useEffect(() => { tsTimeRef.current = ts.time; }, [ts.time]);

  // Animation loop
  useEffect(() => {
    if (!playing) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      lastRealTime.current = null;
      return;
    }

    function tick(realNow: number) {
      if (lastRealTime.current === null) lastRealTime.current = realNow;
      const dtReal = (realNow - lastRealTime.current) / 1000;
      lastRealTime.current = realNow;

      const dtSim = dtReal * SIM_SPEED;
      // reachedEnd is set inside the updater and read after — safe in non-concurrent React
      let reachedEnd = false;

      setTimeIdx(prev => {
        const targetSim = tsTimeRef.current[prev] + dtSim;
        let next = prev;
        while (next < burnIdxEnd && tsTimeRef.current[next + 1] <= targetSim) next++;
        if (next >= burnIdxEnd) {
          reachedEnd = true;
          return burnIdxEnd;
        }
        return next;
      });

      if (reachedEnd) {
        setPlaying(false);
        return;
      }

      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); };
  }, [playing, burnIdxEnd]);

  // Guard: empty stability data
  if (!stabArray.length) {
    return (
      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-gray-200 uppercase tracking-wide">CG/CP Stability Animation</h3>
        <p className="text-xs text-red-400">No stability timeseries data available for this simulation.</p>
      </div>
    );
  }

  // Guard: missing rocket_params
  if (!params) {
    return (
      <div className="space-y-4">
        <h3 className="text-sm font-semibold text-gray-200 uppercase tracking-wide">CG/CP Stability Animation</h3>
        <p className="text-xs text-amber-400">Rocket dimensions not available — re-run the simulation to enable this tool.</p>
      </div>
    );
  }
  const lengthM = params.length_m;
  const diamM = params.diameter_m;

  const CP_m = CP_NORM * lengthM;
  const CP_x = SVG_X0 + CP_NORM * SVG_W;

  function getCGX(idx: number) {
    const stab = stabArray[Math.min(idx, stabArray.length - 1)];
    const cgM = CP_m - stab * diamM;
    return SVG_X0 + (cgM / lengthM) * SVG_W;
  }

  const cgX = getCGX(timeIdx);
  const currentStab = stabArray[Math.min(timeIdx, stabArray.length - 1)] ?? 0;
  const cgDisplay = imp
    ? (CP_m - currentStab * diamM) * 39.3701   // inches
    : (CP_m - currentStab * diamM) * 100;        // centimeters
  const cgUnit = imp ? 'in' : 'cm';
  const currentT = ts.time[Math.min(timeIdx, ts.time.length - 1)] ?? 0;

  function onScrub(e: React.ChangeEvent<HTMLInputElement>) {
    setPlaying(false);
    setTimeIdx(parseInt(e.target.value, 10));
  }

  function togglePlay() {
    if (timeIdx >= burnIdxEnd) setTimeIdx(0);
    setPlaying(p => !p);
  }

  const stabColor = currentStab < 1.0 ? 'text-red-400' : 'text-green-400';
  const minStabColor = minStability < 1.0 ? 'text-red-400' : 'text-gray-200';

  const bracketLeft = Math.min(CP_x, cgX);
  const bracketRight = Math.max(CP_x, cgX);
  const bracketMid = (CP_x + cgX) / 2;

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-gray-200 uppercase tracking-wide">
        CG/CP Stability Animation
      </h3>
      <p className="text-xs text-gray-500">
        CG migrates aft as propellant burns. CP is fixed at ~65% of rocket length from nose
        (normalized approximation). Stability = (CP − CG) / diameter.
      </p>

      {/* Rocket SVG */}
      <div className="bg-gray-950 border border-gray-800 rounded-xl p-4">
        <svg viewBox="0 0 600 100" className="w-full" style={{ height: 90 }}>
          {/* Nosecone */}
          <polygon
            points={`${SVG_X0},50 ${SVG_X0 + 60},28 ${SVG_X0 + 60},72`}
            fill="#1e2435" stroke="white" strokeWidth="1.5"
          />
          {/* Body tube */}
          <rect
            x={SVG_X0 + 60} y={28} width={SVG_W - 100} height={44}
            fill="#1e2435" stroke="white" strokeWidth="1.5" rx="2"
          />
          {/* Fin */}
          <polygon
            points={`${SVG_X1 - 80},50 ${SVG_X1 - 40},20 ${SVG_X1 - 40},80`}
            fill="#1e2435" stroke="white" strokeWidth="1.2"
          />
          {/* Nozzle */}
          <rect
            x={SVG_X1 - 40} y={35} width={40} height={30}
            fill="#1e2435" stroke="white" strokeWidth="1.2" rx="2"
          />

          {/* CP marker — fixed, green */}
          <line x1={CP_x} y1={18} x2={CP_x} y2={78} stroke="#34d399" strokeWidth="2" strokeDasharray="4 3" />
          <text x={CP_x} y={13} textAnchor="middle" fill="#34d399" fontSize="9" fontWeight="bold">CP</text>

          {/* CG marker — animated, amber */}
          <line x1={cgX} y1={18} x2={cgX} y2={78} stroke="#f59e0b" strokeWidth="2" strokeDasharray="4 3" />
          <text x={cgX} y={13} textAnchor="middle" fill="#f59e0b" fontSize="9" fontWeight="bold">CG</text>

          {/* Stability bracket */}
          <line x1={bracketLeft} y1={86} x2={bracketRight} y2={86} stroke="#64748b" strokeWidth="1" />
          <text x={bracketMid} y={97} textAnchor="middle" fill="#64748b" fontSize="8">
            {currentStab.toFixed(2)} cal
          </text>
        </svg>
        <div className="flex gap-5 text-[11px] mt-1.5">
          <span className="text-green-400">— CP (fixed)</span>
          <span className="text-amber-400">-- CG (moves aft as propellant burns)</span>
        </div>
      </div>

      {/* Playback controls */}
      <div className="flex items-center gap-3">
        <button
          onClick={togglePlay}
          className="bg-blue-800 hover:bg-blue-700 rounded-lg px-4 py-1.5 text-white text-xs font-semibold transition-colors shrink-0"
        >
          {playing ? '⏸ Pause' : '▶ Play'}
        </button>
        <input
          type="range" min={0} max={burnIdxEnd} value={timeIdx}
          onChange={onScrub}
          className="flex-1 accent-blue-500"
        />
        <span className="font-mono text-xs text-gray-300 shrink-0">t = {currentT.toFixed(1)}s</span>
        <span className="font-mono text-xs text-gray-600 shrink-0">/ {burnEnd.toFixed(1)}s burnout</span>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-gray-950 border border-gray-800 rounded-lg p-3 text-center">
          <p className="text-[10px] text-gray-500 uppercase mb-1">Stability</p>
          <p className={`text-lg font-mono font-bold ${stabColor}`}>{currentStab.toFixed(2)} cal</p>
        </div>
        <div className="bg-gray-950 border border-gray-800 rounded-lg p-3 text-center">
          <p className="text-[10px] text-gray-500 uppercase mb-1">CG position</p>
          <p className="text-lg font-mono font-bold text-amber-400">{cgDisplay.toFixed(1)} {cgUnit}</p>
        </div>
        <div className="bg-gray-950 border border-gray-800 rounded-lg p-3 text-center">
          <p className="text-[10px] text-gray-500 uppercase mb-1">Min margin</p>
          <p className={`text-lg font-mono font-bold ${minStabColor}`}>
            {Number.isFinite(minStability) ? `${minStability.toFixed(2)} cal` : '—'}
          </p>
        </div>
      </div>
    </div>
  );
}
