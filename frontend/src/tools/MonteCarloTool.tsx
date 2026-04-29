import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { ComparisonResponse } from '../types';
import type { LaunchConfig } from '../components/LaunchConfig';
import type { UnitSystem } from '../components/TimeSeriesCharts';
import { nowRoundedLocalISO } from '../App';

interface Props {
  result: ComparisonResponse;
  config: LaunchConfig;
  unitSystem: UnitSystem;
  selectedFile?: File | null;
}

interface MCStats { mean: number; std: number; p5: number; p50: number; p95: number; }
interface MCResult {
  landings: { lat: number; lon: number }[];
  apogee: MCStats;
  max_velocity: MCStats;
  stability: MCStats;
  n_success: number;
  n_total: number;
}

const M_FT = 3.28084;
const MS_MPH = 2.23694;

export function MonteCarloTool({ result, config, unitSystem, selectedFile }: Props) {
  const imp = unitSystem === 'imperial';
  const [nSims, setNSims] = useState(50);
  // windStd stored in m/s; displayed in mph when imperial
  const [windStdMs, setWindStdMs] = useState(2.0);
  const [massPct, setMassPct] = useState(2.0);
  const [cdPct, setCdPct] = useState(5.0);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [mcResult, setMcResult] = useState<MCResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [useLiveWeather, setUseLiveWeather] = useState(false);
  const [weatherDateTime, setWeatherDateTime] = useState(nowRoundedLocalISO());
  const [orkFile, setOrkFile] = useState<File | null>(selectedFile ?? null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (selectedFile) setOrkFile(selectedFile); }, [selectedFile]);
  const leafletMap = useRef<L.Map | null>(null);
  const landingLayer = useRef<L.LayerGroup | null>(null);

  // Init map — wait until container is visible (handles hidden-on-mount case)
  useEffect(() => {
    const el = mapRef.current;
    if (!el) return;

    const initMap = () => {
      if (leafletMap.current || !el) return;
      const map = L.map(el, { center: [config.lat, config.lon], zoom: 11, zoomAnimation: false });
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '© CartoDB', maxZoom: 18,
      }).addTo(map);
      L.circleMarker([config.lat, config.lon], { radius: 8, color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.9 })
        .bindPopup('Launch Site').addTo(map);
      landingLayer.current = L.layerGroup().addTo(map);
      leafletMap.current = map;
    };

    // If already visible, init immediately
    if (el.offsetParent !== null) {
      initMap();
    } else {
      // Wait for container to become visible
      const visObs = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) {
          visObs.disconnect();
          // Small delay to let layout settle
          setTimeout(initMap, 50);
        }
      }, { threshold: 0 });
      visObs.observe(el);
      return () => visObs.disconnect();
    }

    return () => { if (leafletMap.current) { leafletMap.current.remove(); leafletMap.current = null; } };
  }, []);

  // Resize map when container becomes visible (tab/page switch)
  useEffect(() => {
    const map = leafletMap.current;
    const el = mapRef.current;
    if (!map || !el) return;
    const obs = new ResizeObserver(() => { map.invalidateSize(); });
    obs.observe(el);
    return () => obs.disconnect();
  }, [mcResult]);

  // Update landing scatter on map
  useEffect(() => {
    const layer = landingLayer.current;
    if (!layer || !mcResult) return;
    layer.clearLayers();
    mcResult.landings.forEach(pt => {
      L.circleMarker([pt.lat, pt.lon], {
        radius: 4, color: '#f59e0b', fillColor: '#f59e0b', fillOpacity: 0.5, weight: 0,
      }).addTo(layer);
    });
    // Fit map to landing cluster
    if (mcResult.landings.length > 0) {
      const lats = mcResult.landings.map(p => p.lat);
      const lons = mcResult.landings.map(p => p.lon);
      const bounds = L.latLngBounds(
        [Math.min(...lats, config.lat) - 0.02, Math.min(...lons, config.lon) - 0.02],
        [Math.max(...lats, config.lat) + 0.02, Math.max(...lons, config.lon) + 0.02],
      );
      leafletMap.current?.fitBounds(bounds, { padding: [20, 20] });
    }
  }, [mcResult]);

  const handleRun = async () => {
    if (!orkFile) { setError('Re-select your .ork file'); return; }
    setRunning(true);
    setError(null);
    setMcResult(null);
    setProgress({ done: 0, total: nSims });
    try {
      const formData = new FormData();
      formData.append('file', orkFile);
      const params = new URLSearchParams({
        lat: config.lat.toString(), lon: config.lon.toString(),
        elevation: config.elevation.toString(), rail_length: config.railLength.toString(),
        inclination: config.inclination.toString(), heading: config.heading.toString(),
        n_sims: nSims.toString(),
        wind_speed_std_ms: windStdMs.toString(),
        mass_variation_pct: massPct.toString(),
        cd_variation_pct: cdPct.toString(),
        use_live_weather: useLiveWeather.toString(),
        ...(useLiveWeather ? { sim_datetime: weatherDateTime } : {}),
      });
      const response = await fetch(`/api/monte-carlo?${params}`, { method: 'POST', body: formData });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ detail: response.statusText }));
        throw new Error(body.detail ?? response.statusText);
      }
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          for (const line of part.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            let ev: Record<string, any>;
            try { ev = JSON.parse(line.slice(6)); } catch { continue; }
            if (ev.stage === 'error') throw new Error(ev.message);
            if (ev.stage === 'simulating') setProgress({ done: ev.done ?? 0, total: ev.total ?? nSims });
            if (ev.stage === 'done') setMcResult(ev.result as MCResult);
          }
        }
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  const fmtAlt = (m: number) => imp ? `${Math.round(m * M_FT).toLocaleString()} ft` : `${Math.round(m).toLocaleString()} m`;
  const fmtVel = (ms: number) => imp ? `${(ms * M_FT).toFixed(1)} ft/s` : `${ms.toFixed(1)} m/s`;

  const StatsRow = ({ label, stats }: { label: string; stats: MCStats }) => (
    <tr className="border-b border-gray-800/40">
      <td className="py-1 pr-4 text-gray-400">{label}</td>
      <td className="py-1 px-2 text-right font-mono text-gray-200">
        {label === 'Apogee' ? fmtAlt(stats.mean) : label === 'Max Velocity' ? fmtVel(stats.mean) : stats.mean.toFixed(2)}
      </td>
      <td className="py-1 px-2 text-right font-mono text-gray-500">
        ±{label === 'Apogee' ? fmtAlt(stats.std) : label === 'Max Velocity' ? fmtVel(stats.std) : stats.std.toFixed(2)}
      </td>
      <td className="py-1 px-2 text-right font-mono text-gray-500">
        {label === 'Apogee' ? fmtAlt(stats.p5) : label === 'Max Velocity' ? fmtVel(stats.p5) : stats.p5.toFixed(2)}
      </td>
      <td className="py-1 px-2 text-right font-mono text-gray-500">
        {label === 'Apogee' ? fmtAlt(stats.p50) : label === 'Max Velocity' ? fmtVel(stats.p50) : stats.p50.toFixed(2)}
      </td>
      <td className="py-1 pl-2 text-right font-mono text-gray-500">
        {label === 'Apogee' ? fmtAlt(stats.p95) : label === 'Max Velocity' ? fmtVel(stats.p95) : stats.p95.toFixed(2)}
      </td>
    </tr>
  );

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-gray-200 uppercase tracking-wide">Monte Carlo Dispersion</h3>

      {/* File selector */}
      <div className="flex items-center gap-3 text-xs">
        <input ref={fileInputRef} type="file" accept=".ork" className="hidden"
          onChange={e => setOrkFile(e.target.files?.[0] ?? null)} />
        <button onClick={() => fileInputRef.current?.click()}
          className="bg-gray-800 hover:bg-gray-700 text-gray-300 px-3 py-1.5 rounded-lg transition-colors border border-gray-700">
          {orkFile ? `📄 ${orkFile.name}` : 'Select .ork file'}
        </button>
      </div>

      {/* Weather */}
      <div className="flex items-start gap-3 text-xs">
        <input id="mc-live-weather" type="checkbox" checked={useLiveWeather}
          onChange={e => { const next = e.target.checked; setUseLiveWeather(next); if (next) setWeatherDateTime(nowRoundedLocalISO()); }}
          className="mt-0.5 accent-blue-500" />
        <div className="flex-1">
          <label htmlFor="mc-live-weather" className="text-gray-300 cursor-pointer select-none">Use live weather (NOMADS GFS)</label>
          {useLiveWeather && (
            <div className="mt-2 space-y-1">
              <label className="text-gray-400">Forecast date/time (local)</label>
              <input type="datetime-local" value={weatherDateTime}
                onChange={e => setWeatherDateTime(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs focus:outline-none focus:border-blue-500" />
              <p className="text-gray-600">GFS runs every 6 h — fetches nearest 00/06/12/18 UTC run.</p>
            </div>
          )}
        </div>
      </div>

      {/* Controls */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        {[
          { label: 'Simulations', val: nSims, set: setNSims, min: 10, max: 500, step: 10, unit: '' },
          { label: 'Mass variation', val: massPct, set: setMassPct, min: 0, max: 10, step: 0.5, unit: '%' },
          { label: 'Cd variation', val: cdPct, set: setCdPct, min: 0, max: 20, step: 1, unit: '%' },
        ].map(({ label, val, set, min, max, step, unit }) => (
          <div key={label} className="flex flex-col gap-1">
            <label className="text-gray-400">{label}{unit && <span className="text-gray-600 ml-1">{unit}</span>}</label>
            <input type="number" min={min} max={max} step={step} value={val}
              onChange={e => (set as any)(Number(e.target.value))}
              className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs" />
          </div>
        ))}
        <div className="flex flex-col gap-1">
          <label className="text-gray-400">Wind std <span className="text-gray-600">{imp ? 'mph' : 'm/s'}</span></label>
          <input
            type="number" min={0} max={imp ? 22 : 10} step={imp ? 1 : 0.5}
            value={imp ? parseFloat((windStdMs * MS_MPH).toFixed(1)) : windStdMs}
            onChange={e => setWindStdMs(imp ? Number(e.target.value) / MS_MPH : Number(e.target.value))}
            className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-white text-xs"
          />
        </div>
      </div>

      <button onClick={handleRun} disabled={running || !orkFile}
        className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold px-4 py-2 rounded-lg transition-colors text-sm">
        {running ? (
          <span className="flex items-center gap-2">
            <div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
            {progress.done}/{progress.total} simulations…
          </span>
        ) : `Run ${nSims} Simulations`}
      </button>

      {running && progress.total > 0 && (
        <div className="w-full bg-gray-800 rounded-full h-1.5">
          <div className="bg-blue-500 h-1.5 rounded-full transition-all duration-300"
            style={{ width: `${Math.round(progress.done / progress.total * 100)}%` }} />
        </div>
      )}

      {error && <p className="text-xs text-red-400 bg-red-950/40 border border-red-800 rounded-lg px-3 py-2">{error}</p>}

      {/* Map */}
      <div ref={mapRef} className="w-full rounded-xl overflow-hidden" style={{ height: 420 }} />

      {mcResult && (
        <div className="space-y-3">
          <div className="flex items-center gap-3 text-xs text-gray-500">
            <span className="text-yellow-400">●</span> Landing scatter ({mcResult.n_success}/{mcResult.n_total} successful)
            <span className="text-blue-400">●</span> Launch site
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-700 uppercase text-[10px]">
                  <th className="text-left py-1.5 pr-4">Metric</th>
                  <th className="text-right py-1.5 px-2">Mean</th>
                  <th className="text-right py-1.5 px-2">Std Dev</th>
                  <th className="text-right py-1.5 px-2">P5</th>
                  <th className="text-right py-1.5 px-2">P50</th>
                  <th className="text-right py-1.5 pl-2">P95</th>
                </tr>
              </thead>
              <tbody>
                <StatsRow label="Apogee" stats={mcResult.apogee} />
                <StatsRow label="Max Velocity" stats={mcResult.max_velocity} />
                <StatsRow label="Stability (cal)" stats={mcResult.stability} />
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
