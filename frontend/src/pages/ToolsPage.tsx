import { useState } from 'react';
import type { ComparisonResponse } from '../types';
import type { LaunchConfig } from '../components/LaunchConfig';
import type { UnitSystem } from '../components/TimeSeriesCharts';
import type { WeatherData } from '../components/WeatherPanel';
import { FinFlutterTool } from '../tools/FinFlutterTool';
import { FlightCardTool } from '../tools/FlightCardTool';
import { AirspaceTool } from '../tools/AirspaceTool';
import { ParameterSweepTool } from '../tools/ParameterSweepTool';
import { MotorCompareTool } from '../tools/MotorCompareTool';
import { MonteCarloTool } from '../tools/MonteCarloTool';
import { EjectionChargeTool } from '../tools/EjectionChargeTool';
import { AltimeterTool } from '../tools/AltimeterTool';
import { CGCPAnimationTool } from '../tools/CGCPAnimationTool';

interface ToolsPageProps {
  cachedResult: ComparisonResponse | null;
  config: LaunchConfig;
  unitSystem: UnitSystem;
  selectedFile?: File | null;
  waiverRadiusM?: number;
  mapContainerRef?: HTMLDivElement | null;
  weatherData?: WeatherData;
}

type ToolId = 'flutter' | 'flightcard' | 'airspace' | 'sweep' | 'motors' | 'montecarlo' | 'altimeter' | 'ejection' | 'cgcp';

interface ToolDef {
  id: ToolId;
  label: string;
  description: string;
  icon: React.ReactNode;
  needsResult: boolean;
}

const TOOLS: ToolDef[] = [
  {
    id: 'flutter',
    label: 'Fin Flutter',
    description: 'Critical flutter velocity vs altitude for fin material and geometry',
    needsResult: true,
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 17l4-8 4 4 4-6 4 10" />
      </svg>
    ),
  },
  {
    id: 'flightcard',
    label: 'Flight Card PDF',
    description: 'Export a flight card for your RSO / flight log',
    needsResult: true,
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    ),
  },
  {
    id: 'airspace',
    label: 'Airspace',
    description: 'Live air traffic and active NOTAMs around your launch site',
    needsResult: false,
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064" />
      </svg>
    ),
  },
  {
    id: 'sweep',
    label: 'Parameter Sweep',
    description: 'Vary inclination, rail length, or elevation and see how apogee responds',
    needsResult: true,
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
      </svg>
    ),
  },
  {
    id: 'motors',
    label: 'Motor Comparison',
    description: 'Compare apogee and performance across different motors',
    needsResult: true,
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
      </svg>
    ),
  },
  {
    id: 'montecarlo',
    label: 'Monte Carlo',
    description: 'Dispersion analysis with wind, mass, and drag variation',
    needsResult: true,
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z" />
      </svg>
    ),
  },
  {
    id: 'altimeter',
    label: 'Altimeter Overlay',
    description: 'Upload a flight CSV and overlay altimeter data on RocketPy simulation charts',
    needsResult: true,
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
      </svg>
    ),
  },
  {
    id: 'ejection',
    label: 'Ejection Charge',
    description: 'Black powder ejection charge calculator for drogue and main chute bays',
    needsResult: false,
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 16.121A3 3 0 1012.015 11L11 14H9c0 .768.293 1.536.879 2.121z" />
      </svg>
    ),
  },
  {
    id: 'cgcp',
    label: 'CG/CP Animation',
    description: 'Animate center of gravity migration and stability margin through the burn',
    needsResult: true,
    icon: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l14 9-14 9V3z" />
      </svg>
    ),
  },
];

export function ToolsPage({ cachedResult, config, unitSystem, selectedFile, waiverRadiusM, mapContainerRef, weatherData }: ToolsPageProps) {
  const [activeTool, setActiveTool] = useState<ToolId | null>(null);
  const hasResult = cachedResult !== null;

  return (
    <div className="max-w-7xl mx-auto px-6 py-5 w-full flex-1 space-y-4">
      {/* Rocket context banner */}
      {hasResult ? (
        <div className="flex items-center gap-3 bg-gray-900 border border-gray-800 rounded-xl px-4 py-2.5 text-xs">
          <svg className="w-4 h-4 text-blue-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 3l14 9-14 9V3z" />
          </svg>
          <span className="text-gray-400">
            Loaded: <span className="text-gray-200 font-medium">{cachedResult.rocket_params?.motor_designation || 'Unknown motor'}</span>
            <span className="text-gray-600 mx-1.5">·</span>
            Apogee <span className="text-gray-200">{unitSystem === 'imperial'
              ? `${Math.round(cachedResult.rocketpy_results.apogee_m_agl * 3.28084).toLocaleString()} ft`
              : `${Math.round(cachedResult.rocketpy_results.apogee_m_agl).toLocaleString()} m`}
            </span>
            <span className="text-gray-600 mx-1.5">·</span>
            Launch {config.lat.toFixed(3)}, {config.lon.toFixed(3)}
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-3 bg-gray-900 border border-dashed border-gray-700 rounded-xl px-4 py-3 text-sm text-gray-500">
          <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M12 2a10 10 0 110 20A10 10 0 0112 2z" />
          </svg>
          Run a simulation on the Simulation tab first — most tools use the cached result to pre-fill values.
        </div>
      )}

      {/* Tool grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {TOOLS.map((tool) => {
          const disabled = tool.needsResult && !hasResult;
          const isActive = activeTool === tool.id;
          return (
            <button
              key={tool.id}
              onClick={() => !disabled && setActiveTool(isActive ? null : tool.id)}
              disabled={disabled}
              className={`text-left rounded-xl border p-4 transition-all ${
                isActive
                  ? 'bg-blue-950/40 border-blue-600/50'
                  : disabled
                  ? 'bg-gray-900/40 border-gray-800 opacity-40 cursor-not-allowed'
                  : 'bg-gray-900 border-gray-800 hover:border-gray-600'
              }`}
            >
              <div className={`mb-2 ${isActive ? 'text-blue-400' : 'text-gray-400'}`}>{tool.icon}</div>
              <p className={`text-sm font-semibold mb-0.5 ${isActive ? 'text-blue-300' : 'text-gray-200'}`}>{tool.label}</p>
              <p className="text-xs text-gray-500 leading-relaxed">{tool.description}</p>
              {tool.needsResult && !hasResult && (
                <p className="text-[10px] text-gray-600 mt-1.5">Requires simulation result</p>
              )}
            </button>
          );
        })}
      </div>

      {/* Active tool panel — keep all mounted so state persists across tab switches */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 p-5" style={activeTool ? {} : { display: 'none' }}>
        {cachedResult && (
          <div style={activeTool === 'flutter' ? {} : { display: 'none' }}>
            <FinFlutterTool result={cachedResult} unitSystem={unitSystem} />
          </div>
        )}
        {cachedResult && (
          <div style={activeTool === 'flightcard' ? {} : { display: 'none' }}>
            <FlightCardTool result={cachedResult} config={config} unitSystem={unitSystem} waiverRadiusM={waiverRadiusM} hourlyLandings={cachedResult.hourly_landings} selectedFile={selectedFile} mapContainerRef={mapContainerRef} weatherData={weatherData} />
          </div>
        )}
        <div style={activeTool === 'airspace' ? {} : { display: 'none' }}>
          <AirspaceTool config={config} unitSystem={unitSystem} apogeeM={cachedResult?.rocketpy_results.apogee_m_agl} />
        </div>
        {cachedResult && (
          <div style={activeTool === 'sweep' ? {} : { display: 'none' }}>
            <ParameterSweepTool result={cachedResult} config={config} unitSystem={unitSystem} selectedFile={selectedFile} />
          </div>
        )}
        {cachedResult && (
          <div style={activeTool === 'motors' ? {} : { display: 'none' }}>
            <MotorCompareTool result={cachedResult} config={config} unitSystem={unitSystem} selectedFile={selectedFile} />
          </div>
        )}
        {cachedResult && (
          <div style={activeTool === 'montecarlo' ? {} : { display: 'none' }}>
            <MonteCarloTool result={cachedResult} config={config} unitSystem={unitSystem} selectedFile={selectedFile} />
          </div>
        )}
        {cachedResult && (
          <div style={activeTool === 'altimeter' ? {} : { display: 'none' }}>
            <AltimeterTool result={cachedResult} unitSystem={unitSystem} />
          </div>
        )}
        <div style={activeTool === 'ejection' ? {} : { display: 'none' }}>
          <EjectionChargeTool />
        </div>
        {cachedResult && (
          <div style={activeTool === 'cgcp' ? {} : { display: 'none' }}>
            <CGCPAnimationTool result={cachedResult} />
          </div>
        )}
      </div>
    </div>
  );
}
