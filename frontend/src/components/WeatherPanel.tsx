import { useEffect, useRef, useState } from 'react';
import PlotlyImport from 'react-plotly.js';
const Plot = (PlotlyImport as any).default ?? PlotlyImport;
import type { UnitSystem } from './TimeSeriesCharts';

// ─── Pressure levels covering surface → ~105,000 ft ───────────────────────────
const P_LEVELS = [1000, 925, 850, 700, 500, 400, 300, 250, 200, 150, 100, 70, 50, 30, 20, 10] as const;
const M_FT = 3.28084;

// ISA pressure → altitude (m) — used as fallback when geopotential not yet loaded
function pToAltM(hPa: number): number {
  const T0 = 288.15, L = 0.0065, P0 = 1013.25, g = 9.80665, R = 287.05;
  return Math.max(0, (T0 / L) * (1 - Math.pow(hPa / P0, (R * L) / g)));
}

function degToCompass(deg: number): string {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round(deg / 22.5) % 16];
}

// Direction degree → HSL color: N=blue, E=teal, S=orange, W=purple
function dirColor(deg: number): string {
  const hue = (210 + deg) % 360;
  return `hsl(${hue},70%,55%)`;
}

function wmoLabel(code: number): string {
  if (code === 0) return 'Clear';
  if (code <= 3) return 'Partly cloudy';
  if (code <= 48) return 'Fog';
  if (code <= 55) return 'Drizzle';
  if (code <= 65) return 'Rain';
  if (code <= 75) return 'Snow';
  if (code <= 82) return 'Showers';
  if (code <= 86) return 'Snow showers';
  return 'Thunderstorm';
}

// ─── API ───────────────────────────────────────────────────────────────────────
function buildUrl(lat: number, lon: number, imp: boolean): string {
  const surface = [
    'temperature_2m', 'windspeed_10m', 'winddirection_10m', 'windgusts_10m',
    'precipitation_probability', 'cloudcover', 'cloudcover_low', 'cloudcover_mid',
    'cloudcover_high', 'visibility', 'weathercode',
  ].join(',');

  const pressure = P_LEVELS.flatMap(p => [
    `windspeed_${p}hPa`,
    `winddirection_${p}hPa`,
    `cloudcover_${p}hPa`,
    `geopotential_height_${p}hPa`,
  ]).join(',');

  return (
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=${surface},${pressure}` +
    `&timezone=auto&forecast_days=7` +
    (imp ? '&wind_speed_unit=mph&temperature_unit=fahrenheit' : '')
  );
}

export interface WeatherHourly {
  time: string[];
  temperature_2m: number[];
  windspeed_10m: number[];
  winddirection_10m: number[];
  windgusts_10m: number[];
  precipitation_probability: number[];
  cloudcover: number[];
  cloudcover_low: number[];
  cloudcover_mid: number[];
  cloudcover_high: number[];
  visibility: number[];
  weathercode: number[];
  [key: string]: number[] | string[];
}

export interface WeatherData {
  elevation: number;
  hourly: WeatherHourly;
  hourly_units: Record<string, string>;
}

function useWeather(lat: number, lon: number, imp: boolean) {
  const [data, setData] = useState<WeatherData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prev = useRef('');

  useEffect(() => {
    if (!lat || !lon) return;
    const key = `${lat.toFixed(3)},${lon.toFixed(3)},${imp}`;
    if (key === prev.current) return;
    prev.current = key;

    const url = buildUrl(lat, lon, imp);
    setLoading(true);
    setError(null);
    fetch(url)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(j => { setData(j); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [lat, lon, imp]);

  return { data, loading, error };
}

// ─── Props ────────────────────────────────────────────────────────────────────
interface Props {
  lat: number;
  lon: number;
  elevationM: number;
  launchDateTime: string; // "2025-08-01T14:00"
  unitSystem: UnitSystem;
  onWeatherData?: (data: WeatherData | null) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────
export function WeatherPanel({ lat, lon, elevationM, launchDateTime, unitSystem, onWeatherData }: Props) {
  const imp = unitSystem === 'imperial';
  const { data, loading, error } = useWeather(lat, lon, imp);
  const [selectedHour, setSelectedHour] = useState<string | null>(null);
  const launchSlotRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => { onWeatherData?.(data); }, [data, onWeatherData]);

  useEffect(() => {
    setSelectedHour(null);
  }, [launchDateTime]);

  if (!lat || !lon) return null;

  if (loading) return (
    <div className="bg-gray-900 rounded-xl p-4 flex items-center gap-2.5">
      <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin shrink-0" />
      <p className="text-gray-500 text-sm">Fetching weather forecast...</p>
    </div>
  );

  if (error) return (
    <div className="bg-gray-900 rounded-xl p-4">
      <p className="text-red-400 text-xs">Weather unavailable: {error}</p>
    </div>
  );

  if (!data) return null;

  const { hourly } = data;
  const siteElevM = data.elevation ?? elevationM;

  // Find selected/launch hour index — clicking hourly strip overrides launch time
  const launchHour = launchDateTime.slice(0, 16); // "2025-08-01T14:00"
  const activeHour = selectedHour ?? launchHour;
  let hourIdx = (hourly.time as string[]).findIndex(t => t === activeHour);
  if (hourIdx < 0) hourIdx = 0; // fallback to first available

  // Build wind aloft data for the launch hour
  const altsFt: number[] = [];
  const speeds: number[] = [];
  const dirs: number[] = [];
  const cloudPct: number[] = [];
  const colors: string[] = [];
  const hoverTexts: string[] = [];

  // Surface (10m)
  const surfSpeed = (hourly.windspeed_10m as number[])[hourIdx] ?? 0;
  const surfDir = (hourly.winddirection_10m as number[])[hourIdx] ?? 0;
  altsFt.push(0);
  speeds.push(surfSpeed);
  dirs.push(surfDir);
  cloudPct.push((hourly.cloudcover_low as number[])[hourIdx] ?? 0);
  colors.push(dirColor(surfDir));
  hoverTexts.push(`Surface<br>${surfSpeed.toFixed(0)} ${imp ? 'mph' : 'km/h'} from ${degToCompass(surfDir)}<br>0 ft AGL`);

  // Pressure levels
  for (const p of P_LEVELS) {
    const ws = (hourly[`windspeed_${p}hPa`] as number[])?.[hourIdx];
    const wd = (hourly[`winddirection_${p}hPa`] as number[])?.[hourIdx];
    const cc = (hourly[`cloudcover_${p}hPa`] as number[])?.[hourIdx] ?? 0;
    const gph = (hourly[`geopotential_height_${p}hPa`] as number[])?.[hourIdx];

    if (ws == null || wd == null) continue;

    const altM = gph != null ? gph - siteElevM : pToAltM(p) - siteElevM;
    if (altM < 0) continue;
    const altFt = altM * M_FT;

    altsFt.push(altFt);
    speeds.push(ws);
    dirs.push(wd);
    cloudPct.push(cc);
    colors.push(dirColor(wd));
    hoverTexts.push(
      `${p} hPa<br>${ws.toFixed(0)} ${imp ? 'mph' : 'km/h'} from ${degToCompass(wd)}<br>${Math.round(altFt).toLocaleString()} ft AGL<br>Cloud: ${cc.toFixed(0)}%`
    );
  }

  // Sort by altitude ascending
  const order = altsFt.map((_, i) => i).sort((a, b) => altsFt[a] - altsFt[b]);
  const sortedAlt = order.map(i => altsFt[i]);
  const sortedSpeed = order.map(i => speeds[i]);
  const sortedDirs = order.map(i => dirs[i]);
  const sortedCloud = order.map(i => cloudPct[i]);
  const sortedColors = order.map(i => colors[i]);
  const sortedHover = order.map(i => hoverTexts[i]);

  const altUnit = imp ? 'ft' : 'm';
  const speedUnit = imp ? 'mph' : 'km/h';
  const displayAlts = imp ? sortedAlt : sortedAlt.map(ft => ft / M_FT);
  const maxAlt = imp ? 110000 : 33500;

  const windTrace: any = {
    type: 'scatter',
    mode: 'lines+markers+text',
    x: sortedSpeed,
    y: displayAlts,
    text: sortedSpeed.map((s, i) => `${s.toFixed(0)} ${degToCompass(sortedDirs[i])}`),
    textposition: 'middle right',
    textfont: { color: '#9ca3af', size: 9 },
    customdata: sortedHover,
    hovertemplate: '%{customdata}<extra></extra>',
    line: { color: '#374151', width: 1.5 },
    marker: {
      color: sortedColors,
      size: 9,
      line: { color: '#1f2937', width: 1 },
    },
    name: 'Wind',
    showlegend: false,
  };

  const layout: any = {
    paper_bgcolor: '#111827',
    plot_bgcolor: '#1f2937',
    margin: { t: 10, r: 80, b: 40, l: 70 },
    height: 420,
    autosize: true,
    xaxis: {
      title: { text: `Wind Speed (${speedUnit})`, font: { color: '#9ca3af', size: 11 } },
      gridcolor: '#374151', color: '#6b7280', tickfont: { size: 9 },
      rangemode: 'tozero',
    },
    yaxis: {
      title: { text: `Altitude AGL (${altUnit})`, font: { color: '#9ca3af', size: 11 } },
      gridcolor: '#374151', color: '#6b7280', tickfont: { size: 9 },
      range: [0, maxAlt],
      tickformat: ',.0f',
    },
  };

  // ─── Cloud table data — high altitude at top, low at bottom ──────────────────
  function cloudTerm(pct: number): string {
    if (pct < 5)  return 'CLR';
    if (pct < 25) return 'FEW';
    if (pct < 50) return 'SCT';
    if (pct < 88) return 'BKN';
    return 'OVC';
  }
  function cloudRowStyle(pct: number): string {
    if (pct < 5)  return 'text-gray-600';
    if (pct < 25) return 'text-blue-400';
    if (pct < 50) return 'text-yellow-400';
    if (pct < 88) return 'text-orange-400';
    return 'text-red-400';
  }
  // Build from sorted order (ascending alt), then reverse for display (high→low)
  const cloudRows = sortedAlt
    .map((_, i) => ({
      altDisplay: imp ? Math.round(sortedAlt[i]).toLocaleString() : Math.round(sortedAlt[i] / M_FT).toLocaleString(),
      pct: Math.round(sortedCloud[i]),
    }))
    .reverse(); // high altitude at top

  // ─── Hourly strip for the selected date ──────────────────────────────────────
  const selectedDate = launchHour.slice(0, 10); // "2025-08-01"
  const dayHours = (hourly.time as string[])
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.startsWith(selectedDate));

  // Current local hour in "YYYY-MM-DDTHH:00" format (matches Open-Meteo local timezone)
  const nowHour = (() => {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); // shift so UTC = local
    d.setUTCMinutes(0, 0, 0);                             // round to hour
    return d.toISOString().slice(0, 16);
  })();

  // ─── Launch time summary ──────────────────────────────────────────────────────
  const launchTemp = (hourly.temperature_2m as number[])[hourIdx];
  const launchWind = (hourly.windspeed_10m as number[])[hourIdx];
  const launchGust = (hourly.windgusts_10m as number[])[hourIdx];
  const launchWindDir = (hourly.winddirection_10m as number[])[hourIdx];
  const launchCloud = (hourly.cloudcover as number[])[hourIdx];
  const launchVis = (hourly.visibility as number[])[hourIdx]; // meters
  const launchCode = (hourly.weathercode as number[])[hourIdx];
  const launchPrecip = (hourly.precipitation_probability as number[])[hourIdx];

  const tempUnit = imp ? '°F' : '°C';
  const visDisplay = imp
    ? `${(launchVis / 1609).toFixed(1)} mi`
    : `${(launchVis / 1000).toFixed(1)} km`;

  const cloudLow = (hourly.cloudcover_low as number[])[hourIdx] ?? 0;
  const cloudMid = (hourly.cloudcover_mid as number[])[hourIdx] ?? 0;
  const cloudHigh = (hourly.cloudcover_high as number[])[hourIdx] ?? 0;

  return (
    <div className="bg-gray-900 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wide">Launch Window Weather</h2>
        <span className="text-xs text-gray-600">{lat.toFixed(3)}, {lon.toFixed(3)}</span>
      </div>

      {/* Launch time summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          { label: 'Conditions', value: wmoLabel(launchCode) },
          { label: 'Surface Wind', value: `${launchWind?.toFixed(0)} ${speedUnit} ${degToCompass(launchWindDir)} (gusts ${launchGust?.toFixed(0)})` },
          { label: 'Temperature', value: `${launchTemp?.toFixed(0)}${tempUnit}` },
          { label: 'Cloud Cover', value: `${launchCloud?.toFixed(0)}%${launchPrecip > 0 ? ` · ${launchPrecip}% precip` : ''}` },
          { label: 'Visibility', value: visDisplay },
          { label: 'Low Clouds', value: `${cloudLow.toFixed(0)}%` },
          { label: 'Mid Clouds', value: `${cloudMid.toFixed(0)}%` },
          { label: 'High Clouds', value: `${cloudHigh.toFixed(0)}%` },
        ].map(({ label, value }) => (
          <div key={label} className="bg-gray-800/50 rounded-lg px-3 py-2">
            <p className="text-xs text-gray-500 uppercase tracking-wide mb-0.5">{label}</p>
            <p className="text-sm text-gray-200 font-medium">{value ?? '—'}</p>
          </div>
        ))}
      </div>

      {/* Wind aloft + cloud table */}
      <div>
        <p className="text-xs text-gray-600 mb-1 uppercase tracking-wide font-medium">
          Wind Aloft &amp; Clouds — {activeHour.replace('T', ' ')} local · click hour below to update
        </p>
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-3 items-start">
          {/* Wind chart */}
          <div>
            <Plot
              data={[windTrace]}
              layout={layout}
              config={{ responsive: true, displayModeBar: false }}
              style={{ width: '100%' }}
              useResizeHandler
            />
            <div className="flex items-center gap-4 mt-1 flex-wrap">
              {(['N', 'E', 'S', 'W'] as const).map(dir => {
                const deg = dir === 'N' ? 0 : dir === 'E' ? 90 : dir === 'S' ? 180 : 270;
                return (
                  <div key={dir} className="flex items-center gap-1.5">
                    <div className="w-3 h-3 rounded-full" style={{ background: dirColor(deg) }} />
                    <span className="text-xs text-gray-500">From {dir}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Cloud table */}
          <div className="bg-gray-800/40 rounded-lg overflow-hidden">
            <div className="px-3 py-2 border-b border-gray-700">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Cloud Layers</p>
              <p className="text-xs text-gray-600 mt-0.5">{altUnit} AGL · CLR FEW SCT BKN OVC</p>
            </div>
            <div className="overflow-y-auto" style={{ maxHeight: 380 }}>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-700">
                    <th className="text-left px-3 py-1.5 text-gray-500 font-medium">Alt ({altUnit})</th>
                    <th className="text-right px-3 py-1.5 text-gray-500 font-medium">Cover</th>
                    <th className="text-right px-3 py-1.5 text-gray-500 font-medium">Term</th>
                  </tr>
                </thead>
                <tbody>
                  {cloudRows.map(({ altDisplay, pct }, idx) => {
                    const term = cloudTerm(pct);
                    const style = cloudRowStyle(pct);
                    const isCeiling = term === 'BKN' || term === 'OVC';
                    return (
                      <tr
                        key={idx}
                        className={`border-b border-gray-700/40 ${isCeiling ? 'bg-orange-900/10' : ''}`}
                      >
                        <td className={`px-3 py-1 tabular-nums ${pct < 5 ? 'text-gray-600' : 'text-gray-300'}`}>
                          {altDisplay}
                        </td>
                        <td className="px-3 py-1 text-right">
                          {pct > 0 ? (
                            <div className="flex items-center justify-end gap-1.5">
                              <div className="w-16 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                                <div
                                  className="h-full rounded-full"
                                  style={{
                                    width: `${pct}%`,
                                    background: pct < 25 ? '#60a5fa' : pct < 50 ? '#facc15' : pct < 88 ? '#fb923c' : '#ef4444',
                                  }}
                                />
                              </div>
                              <span className={`tabular-nums ${style}`}>{pct}%</span>
                            </div>
                          ) : (
                            <span className="text-gray-700">—</span>
                          )}
                        </td>
                        <td className={`px-3 py-1 text-right font-mono font-semibold ${style}`}>
                          {term}
                          {isCeiling && <span className="text-orange-500 ml-1 text-xs">▲</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="px-3 py-2 border-t border-gray-700">
              <p className="text-xs text-gray-700">BKN/OVC = ceiling · orange rows</p>
            </div>
          </div>
        </div>
      </div>

      {/* Hourly strip */}
      {dayHours.length > 0 && (
        <div>
          <p className="text-xs text-gray-600 mb-1 uppercase tracking-wide font-medium">Hourly — {selectedDate}</p>
          <div className="overflow-x-auto">
            <div className="flex gap-1 min-w-max pb-1">
              {dayHours.map(({ t, i }) => {
                const isActive = t === activeHour;
                const isLaunch = t === launchHour;
                const isNow = t === nowHour;
                const hr = t.slice(11, 16);
                const ws = (hourly.windspeed_10m as number[])[i];
                const wd = (hourly.winddirection_10m as number[])[i];
                const cc = (hourly.cloudcover as number[])[i];
                return (
                  <button
                    key={t}
                    ref={isLaunch ? launchSlotRef : null}
                    type="button"
                    onClick={() => setSelectedHour(t === launchHour && !selectedHour ? null : t)}
                    className={`flex flex-col items-center gap-0.5 px-2 py-1.5 rounded-lg min-w-[48px] transition-colors ${
                      isActive
                        ? 'bg-blue-600/20 border border-blue-500/40'
                        : isNow
                        ? 'bg-green-900/20 border border-green-700/40 hover:bg-green-800/30'
                        : 'bg-gray-800/40 hover:bg-gray-700/60'
                    }`}
                  >
                    {isNow
                      ? <span className="text-green-400 text-[9px] leading-none font-bold tracking-tight">▼ now</span>
                      : <span className="text-[9px] leading-none opacity-0 select-none">▼</span>
                    }
                    <span className={`text-xs font-medium ${isActive ? 'text-blue-300' : isNow ? 'text-green-300' : isLaunch ? 'text-gray-400' : 'text-gray-500'}`}>
                      {hr}{isLaunch && !isActive ? ' *' : ''}
                    </span>
                    <div
                      className="w-2 h-2 rounded-full"
                      style={{ background: dirColor(wd) }}
                      title={`From ${degToCompass(wd)}`}
                    />
                    <span className="text-xs text-gray-300 tabular-nums">{ws?.toFixed(0)}</span>
                    <span className="text-xs text-gray-600">{cc?.toFixed(0)}%</span>
                  </button>
                );
              })}
            </div>
          </div>
          <p className="text-xs text-gray-700 mt-1">
            Wind {speedUnit} · cloud % · dot = wind direction · * = launch · ▼ = now · click to view wind aloft
          </p>
        </div>
      )}
    </div>
  );
}
