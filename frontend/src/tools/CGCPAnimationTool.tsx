import { useState, useEffect, useRef, useMemo } from 'react';
import type { ComparisonResponse } from '../types';

interface Props {
  result: ComparisonResponse;
  unitSystem: 'imperial' | 'metric';
}

// SVG canvas matches matplotlib figsize(13,4) at 100px/in = 1300×400
// Axes area estimated at x=[6%,97%], y=[12%,82%] of the saved PNG
// (bbox_inches="tight", y-axis hidden, xlabel + title present)
const IMG_W = 1300;
const IMG_H = 400;
const AX_LEFT = 0.06 * IMG_W;   // ~78 — left of data area
const AX_RIGHT = 0.97 * IMG_W;  // ~1261 — right of data area
const AX_W = AX_RIGHT - AX_LEFT;

// Lines span the central band of the axes (clears title + xlabel zones)
const LINE_Y1 = 0.22 * IMG_H;       // 88
const LINE_Y2 = 0.73 * IMG_H;       // 292
const LABEL_Y_TOP = 0.13 * IMG_H;   // 52  — label above line
const BRACKET_Y = 0.82 * IMG_H;     // 328 — bracket below body
const BRACKET_LABEL_Y = 0.93 * IMG_H; // 372

// Fallback CP fraction when backend doesn't provide exact position
const CP_NORM_FALLBACK = 0.65;

// Animation: 1 real second = 0.75 sim seconds (slower than real time — easier to follow)
const SIM_SPEED = 0.75;

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
  // Accumulated simulation time — increments independently each real frame so the
  // animation advances even when simulation timesteps are larger than one frame's dtSim.
  const simTimeRef = useRef(0);
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

      // Accumulate sim time — this advances regardless of state update batching
      simTimeRef.current += dtReal * SIM_SPEED;
      const targetSim = simTimeRef.current;

      let reachedEnd = false;
      setTimeIdx(prev => {
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
  const diagram = result.rocket_diagram;

  // Use exact nose/tail fractions from the backend matplotlib transform when available.
  // Fallback: estimate from axes calibration constants (pre-transform path).
  const noseFrac = result.diagram_nose_frac;
  const tailFrac = result.diagram_tail_frac;

  const totalInch = lengthM * 39.3701;
  const dataSpan = totalInch + 0.6;
  const SVG_X0 = noseFrac != null
    ? noseFrac * IMG_W
    : AX_LEFT + (0.3 / dataSpan) * AX_W;
  const SVG_X1 = tailFrac != null
    ? tailFrac * IMG_W
    : AX_LEFT + ((totalInch + 0.3) / dataSpan) * AX_W;
  const SVG_W = SVG_X1 - SVG_X0;

  // Use exact CP from backend when available, fall back to 65% estimate
  const CP_m = rpy.cp_position_m ?? CP_NORM_FALLBACK * lengthM;
  const CP_x = SVG_X0 + (CP_m / lengthM) * SVG_W;

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
    const idx = parseInt(e.target.value, 10);
    setTimeIdx(idx);
    simTimeRef.current = ts.time[idx] ?? 0;
  }

  function togglePlay() {
    if (timeIdx >= burnIdxEnd) {
      setTimeIdx(0);
      simTimeRef.current = ts.time[0] ?? 0;
    } else {
      simTimeRef.current = ts.time[timeIdx] ?? 0;
    }
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
        CG migrates forward (toward nose) as propellant burns off, increasing stability.
        CP is fixed. Stability = (CP − CG) / diameter.
      </p>

      {/* Rocket diagram + animated overlay */}
      <div className="bg-gray-950 border border-gray-800 rounded-xl overflow-hidden">
        <svg
          viewBox={`0 0 ${IMG_W} ${IMG_H}`}
          className="w-full"
          style={{ display: 'block' }}
        >
          {diagram ? (
            /* OR diagram as background — slightly dimmed so animated overlay stands out */
            <image
              href={`data:image/png;base64,${diagram}`}
              x={0} y={0}
              width={IMG_W} height={IMG_H}
              preserveAspectRatio="xMidYMid meet"
              opacity={0.35}
            />
          ) : (
            /* Fallback: hand-drawn rocket */
            <>
              <polygon
                points={`${SVG_X0},${IMG_H / 2} ${SVG_X0 + 120},${IMG_H / 2 - 50} ${SVG_X0 + 120},${IMG_H / 2 + 50}`}
                fill="#1e2435" stroke="white" strokeWidth="2.5"
              />
              <rect
                x={SVG_X0 + 120} y={IMG_H / 2 - 50} width={SVG_W - 200} height={100}
                fill="#1e2435" stroke="white" strokeWidth="2.5" rx="3"
              />
              <polygon
                points={`${SVG_X1 - 160},${IMG_H / 2} ${SVG_X1 - 80},${IMG_H / 2 - 90} ${SVG_X1 - 80},${IMG_H / 2 + 90}`}
                fill="#1e2435" stroke="white" strokeWidth="2"
              />
              <rect
                x={SVG_X1 - 80} y={IMG_H / 2 - 60} width={80} height={120}
                fill="#1e2435" stroke="white" strokeWidth="2" rx="3"
              />
            </>
          )}

          {/* CP marker — fixed, green */}
          <line x1={CP_x} y1={LINE_Y1} x2={CP_x} y2={LINE_Y2}
            stroke="#34d399" strokeWidth="4" strokeDasharray="12 7" />
          <rect x={CP_x - 36} y={LABEL_Y_TOP - 28} width={72} height={32}
            rx={6} fill="#052e16" opacity={0.85} />
          <text x={CP_x} y={LABEL_Y_TOP} textAnchor="middle"
            fill="#34d399" fontSize="26" fontWeight="bold">CP</text>

          {/* CG marker — animated, amber */}
          <line x1={cgX} y1={LINE_Y1} x2={cgX} y2={LINE_Y2}
            stroke="#f59e0b" strokeWidth="4" strokeDasharray="12 7" />
          <rect x={cgX - 36} y={LABEL_Y_TOP - 28} width={72} height={32}
            rx={6} fill="#1c1000" opacity={0.85} />
          <text x={cgX} y={LABEL_Y_TOP} textAnchor="middle"
            fill="#f59e0b" fontSize="26" fontWeight="bold">CG</text>

          {/* Stability bracket */}
          <line x1={bracketLeft} y1={BRACKET_Y} x2={bracketRight} y2={BRACKET_Y}
            stroke="#64748b" strokeWidth="2" />
          <text x={bracketMid} y={BRACKET_LABEL_Y} textAnchor="middle"
            fill="#94a3b8" fontSize="22" fontWeight="bold">
            {currentStab.toFixed(2)} cal
          </text>
        </svg>
        <div className="flex gap-5 text-[11px] px-3 pb-2 pt-1">
          <span className="text-green-400">— CP (fixed)</span>
          <span className="text-amber-400">-- CG (moves forward toward nose as propellant burns)</span>
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
