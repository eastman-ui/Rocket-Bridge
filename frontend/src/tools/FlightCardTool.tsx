import { useState } from 'react';
import type { ComparisonResponse, HourlyLanding } from '../types';
import type { LaunchConfig } from '../components/LaunchConfig';
import type { UnitSystem } from '../components/TimeSeriesCharts';

interface Props {
  result: ComparisonResponse;
  config: LaunchConfig;
  unitSystem: UnitSystem;
  waiverRadiusM?: number;
  hourlyLandings?: HourlyLanding[];
  selectedFile?: File | null;
  mapContainerRef?: HTMLDivElement | null;
}

const M_FT = 3.28084;
const MS_FTS = 3.28084;
const N_LBF = 0.224809;
const MI_M = 1609.34;

export function FlightCardTool({ result, config, unitSystem, waiverRadiusM, hourlyLandings, selectedFile, mapContainerRef }: Props) {
  const imp = unitSystem === 'imperial';
  const rpy = result.rocketpy_results;
  const or_ = result.or_results;
  const params = result.rocket_params;
  const [mcImage, setMcImage] = useState<string | null>(null);
  const [mcRunning, setMcRunning] = useState(false);

  const fmtAlt = (m: number) => imp ? `${Math.round(m * M_FT).toLocaleString()} ft` : `${Math.round(m).toLocaleString()} m`;
  const fmtVel = (ms: number) => imp ? `${(ms * MS_FTS).toFixed(1)} ft/s` : `${ms.toFixed(1)} m/s`;
  const fmtDist = (m: number) => imp ? `${(m / MI_M).toFixed(2)} mi` : `${(m / 1000).toFixed(2)} km`;

  // Drift distance: prefer MC 95th percentile when available, else single-flight drift
  const [mcDriftDist, setMcDriftDist] = useState(0);
  const driftDist = mcDriftDist > 0 ? mcDriftDist : (rpy.drift_distance_m ?? 0);
  const waiverM = waiverRadiusM ?? MI_M;
  const waiverViolated = driftDist > waiverM && driftDist > 0;

  const R_EARTH = 6378137;
  function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRad = (d: number) => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R_EARTH * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  const handleRunQuickMC = async () => {
    if (!selectedFile) { setMcImage(null); return; }
    setMcRunning(true);
    setMcImage(null);
    try {
      const formData = new FormData();
      formData.append('file', selectedFile);
      const mcParams = new URLSearchParams({
        lat: config.lat.toString(), lon: config.lon.toString(),
        elevation: config.elevation.toString(), rail_length: config.railLength.toString(),
        inclination: config.inclination.toString(), heading: config.heading.toString(),
        n_sims: '10', wind_speed_std_ms: '2.0', mass_variation_pct: '2.0', cd_variation_pct: '5.0',
        use_live_weather: 'true', sim_datetime: new Date().toISOString().slice(0, 16),
      });
      const response = await fetch(`/api/monte-carlo?${mcParams}`, { method: 'POST', body: formData });
      if (!response.ok) throw new Error('MC failed');
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let mcResult: any = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          for (const line of part.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try { const ev = JSON.parse(line.slice(6)); if (ev.stage === 'done') mcResult = ev.result; } catch { /* skip */ }
          }
        }
      }
      if (mcResult && mcResult.landings) {
        // Compute 95th percentile drift distance from MC landings
        const dists = mcResult.landings.map((p: any) => haversineMeters(config.lat, config.lon, p.lat, p.lon)).sort((a: number, b: number) => a - b);
        const p95 = dists[Math.min(Math.ceil(0.95 * dists.length) - 1, dists.length - 1)];
        if (p95 > 0) setMcDriftDist(Math.round(p95));
        // Generate map-context MC scatter image
        const canvas = document.createElement('canvas');
        canvas.width = 500; canvas.height = 400;
        const ctx = canvas.getContext('2d')!;
        // Dark background
        ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, 500, 400);
        const lats = mcResult.landings.map((p: any) => p.lat);
        const lons = mcResult.landings.map((p: any) => p.lon);
        // Expand bounds to show waiver circle + context
        const waiverDegLat = waiverM / 111111;
        const waiverDegLon = waiverM / (111111 * Math.cos(config.lat * Math.PI / 180));
        const minLat = Math.min(...lats, config.lat - waiverDegLat) - 0.002;
        const maxLat = Math.max(...lats, config.lat + waiverDegLat) + 0.002;
        const minLon = Math.min(...lons, config.lon - waiverDegLon) - 0.002;
        const maxLon = Math.max(...lons, config.lon + waiverDegLon) + 0.002;
        const pad = 30;
        const plotW = 500 - 2 * pad;
        const plotH = 400 - 2 * pad;
        const sx = (lon: number) => pad + (lon - minLon) / (maxLon - minLon || 0.001) * plotW;
        const sy = (lat: number) => pad + plotH - (lat - minLat) / (maxLat - minLat || 0.001) * plotH;
        // Draw lat/lon grid
        ctx.strokeStyle = '#1e3a5f'; ctx.lineWidth = 0.5; ctx.setLineDash([]);
        const latStep = Math.max(0.001, Math.round((maxLat - minLat) / 5 * 10000) / 10000);
        const lonStep = Math.max(0.001, Math.round((maxLon - minLon) / 5 * 10000) / 10000);
        ctx.fillStyle = '#4b6584'; ctx.font = '8px monospace'; ctx.textAlign = 'center';
        for (let lat = Math.ceil(minLat / latStep) * latStep; lat <= maxLat; lat += latStep) {
          const py = sy(lat);
          ctx.beginPath(); ctx.moveTo(pad, py); ctx.lineTo(500 - pad, py); ctx.stroke();
          ctx.fillText(lat.toFixed(4), 500 - pad + 2, py + 3);
        }
        ctx.textAlign = 'left';
        for (let lon = Math.ceil(minLon / lonStep) * lonStep; lon <= maxLon; lon += lonStep) {
          const px = sx(lon);
          ctx.beginPath(); ctx.moveTo(px, pad); ctx.lineTo(px, 400 - pad); ctx.stroke();
          ctx.fillText(lon.toFixed(4), px - 10, pad - 4);
        }
        // Draw waiver circle
        ctx.strokeStyle = '#ef4444'; ctx.setLineDash([6, 4]); ctx.lineWidth = 1.5;
        const cX = sx(config.lon), cY = sy(config.lat);
        const edgeX = sx(config.lon + waiverDegLon);
        ctx.beginPath(); ctx.arc(cX, cY, edgeX - cX, 0, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]);
        // Draw launch point
        ctx.fillStyle = '#3b82f6'; ctx.beginPath(); ctx.arc(cX, cY, 6, 0, 2 * Math.PI); ctx.fill();
        ctx.fillStyle = '#93c5fd'; ctx.font = '9px sans-serif'; ctx.fillText('Launch', cX + 8, cY + 3);
        // Draw landing scatter
        ctx.fillStyle = '#f59e0b99';
        for (const pt of mcResult.landings) { ctx.beginPath(); ctx.arc(sx(pt.lon), sy(pt.lat), 3.5, 0, 2 * Math.PI); ctx.fill(); }
        // Labels
        ctx.fillStyle = '#9ca3af'; ctx.font = '10px monospace'; ctx.textAlign = 'left';
        ctx.fillText('MC Scatter (10 sims)', pad, pad - 16);
        ctx.fillText(`${mcResult.n_success ?? '?'}/${mcResult.n_total ?? 10} success`, 400, pad - 16);
        ctx.fillText(`95th pctl: ${fmtDist(p95)}`, pad, 400 - pad + 16);
        setMcImage(canvas.toDataURL('image/png'));
      }
    } catch { setMcImage(null); }
    finally { setMcRunning(false); }
  };

  const handleExport = async () => {
    const { jsPDF } = await import('jspdf');
    const autoTable = (await import('jspdf-autotable')).default;
    const html2canvas = (await import('html2canvas')).default;

    const doc = new jsPDF({ unit: 'mm', format: 'letter' });
    const W = doc.internal.pageSize.getWidth();

    // Header
    doc.setFillColor(17, 24, 39); doc.rect(0, 0, W, 22, 'F');
    doc.setTextColor(255, 255, 255); doc.setFontSize(16); doc.setFont('helvetica', 'bold');
    doc.text('FLIGHT CARD', 14, 12);
    doc.setFontSize(9); doc.setFont('helvetica', 'normal'); doc.setTextColor(156, 163, 175);
    doc.text('Generated by RocketBridge', 14, 18);
    doc.text(new Date().toLocaleString(), W - 14, 18, { align: 'right' });

    let y = 30;

    // Motor summary
    doc.setTextColor(30, 30, 30); doc.setFontSize(11); doc.setFont('helvetica', 'bold');
    doc.text(params?.motor_designation || 'Unknown Motor', 14, y);
    if (params) {
      y += 5; doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(100, 100, 100);
      doc.text(`Length: ${(params.length_m * (imp ? 39.3701 : 100)).toFixed(1)} ${imp ? 'in' : 'cm'}   Diameter: ${(params.diameter_m * (imp ? 39.3701 : 1000)).toFixed(1)} ${imp ? 'in' : 'mm'}   Wet: ${imp ? (params.wet_mass_kg * 2.20462).toFixed(2) + ' lb' : params.wet_mass_kg.toFixed(3) + ' kg'}`, 14, y);
    }
    y += 8;

    // Stats table
    const rows: [string, string, string][] = [
      ['Apogee AGL', fmtAlt(rpy.apogee_m_agl), or_?.apogee_m_agl != null ? fmtAlt(or_.apogee_m_agl) : '—'],
      ['Max Velocity', fmtVel(rpy.max_speed_ms), or_?.max_velocity_ms != null ? fmtVel(or_.max_velocity_ms!) : '—'],
      ['Max Mach', `Mach ${rpy.max_mach.toFixed(3)}`, or_?.max_mach != null ? `Mach ${or_.max_mach!.toFixed(3)}` : '—'],
      ['Stability (Mach 0.3)', `${(rpy.static_margin_mach03_cal ?? 0).toFixed(2)} cal`, or_?.stability_margin_mach03_cal != null ? `${or_.stability_margin_mach03_cal!.toFixed(2)} cal` : '—'],
      ['Off-Rail Velocity', fmtVel(rpy.out_of_rail_velocity), or_?.velocity_off_rail_ms != null ? fmtVel(or_.velocity_off_rail_ms!) : '—'],
      ['Burn Time', `${rpy.burn_out_time_s.toFixed(2)} s`, '—'],
      ['Time to Apogee', `${rpy.apogee_time_s.toFixed(1)} s`, or_?.time_to_apogee_s != null ? `${or_.time_to_apogee_s!.toFixed(1)} s` : '—'],
      ['Landing Speed', rpy.impact_velocity_ms > 0 ? fmtVel(rpy.impact_velocity_ms) : '—', '—'],
      ['Main Chute Descent', rpy.main_descent_speed_ms > 0 ? fmtVel(rpy.main_descent_speed_ms) : '—', or_?.main_descent_speed_ms != null ? fmtVel(or_.main_descent_speed_ms!) : '—'],
      ['Drogue Descent', rpy.drogue_descent_speed_ms > 0 ? fmtVel(rpy.drogue_descent_speed_ms) : '—', or_?.drogue_descent_speed_ms != null ? fmtVel(or_.drogue_descent_speed_ms!) : '—'],
      ['Drift Distance', driftDist > 0 ? fmtDist(driftDist) : '—', '—'],
      ['FAA Waiver Radius', fmtDist(waiverM), '—'],
      ['Waiver Status', waiverViolated ? 'EXCEEDS WAIVER' : 'Within waiver', '—'],
      ['Weather', rpy.weather_source === 'standard_atmosphere' ? 'Std Atmosphere' : 'NOMADS GFS', '—'],
    ];

    autoTable(doc, {
      startY: y,
      head: [['Parameter', 'RocketPy', 'OpenRocket']],
      body: rows,
      theme: 'grid',
      headStyles: { fillColor: [17, 24, 39], textColor: [255, 255, 255], fontSize: 8, fontStyle: 'bold' },
      bodyStyles: { fontSize: 8, textColor: [30, 30, 30] },
      columnStyles: { 0: { fontStyle: 'bold', cellWidth: 55 }, 1: { cellWidth: 60 }, 2: { cellWidth: 60 } },
      margin: { left: 14, right: 14 },
      didParseCell: (data: any) => {
        if (data.row.index === rows.length - 1 && data.column.index > 0) {
          data.cell.styles.textColor = waiverViolated ? [220, 38, 38] : [22, 163, 74];
          data.cell.styles.fontStyle = waiverViolated ? 'bold' : 'normal';
        }
      },
    });
    y = (doc as any).lastAutoTable.finalY + 8;

    // Rocket diagram
    if (result.rocket_diagram) {
      const imgW = W - 28;
      try {
        doc.addImage(`data:image/png;base64,${result.rocket_diagram}`, 'PNG', 14, y, imgW, imgW * 0.25);
        y += imgW * 0.25 + 6;
      } catch { /* skip */ }
    }

    // Map screenshot
    if (mapContainerRef) {
      try {
        const canvas = await html2canvas(mapContainerRef, { useCORS: true, allowTaint: true, backgroundColor: '#111827', scale: 2 });
        const imgData = canvas.toDataURL('image/png');
        const mapW = W - 28;
        const mapH = mapW * 0.6;
        doc.addImage(imgData, 'PNG', 14, y, mapW, mapH);
        y += mapH + 6;
      } catch { /* skip if map capture fails */ }
    }

    // MC scatter image
    if (mcImage) {
      try { doc.addImage(mcImage, 'PNG', 14, y, 80, 60); y += 64; } catch { /* skip */ }
    }

    // Footer
    const pageH = doc.internal.pageSize.getHeight();
    doc.setFillColor(17, 24, 39); doc.rect(0, pageH - 10, W, 10, 'F');
    doc.setFontSize(7); doc.setTextColor(156, 163, 175);
    doc.text('RocketBridge · rocketpy + openrocket comparison', 14, pageH - 3);
    doc.text(`Simulated ${new Date().toLocaleDateString()}`, W - 14, pageH - 3, { align: 'right' });
    doc.save(`flight-card-${params?.motor_designation || 'rocket'}.pdf`);
  };

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-gray-200 uppercase tracking-wide">Flight Card PDF Export</h3>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
        {[
          { label: 'Motor', value: params?.motor_designation || '—' },
          { label: 'Apogee AGL', value: fmtAlt(rpy.apogee_m_agl) },
          { label: 'Max Velocity', value: fmtVel(rpy.max_speed_ms) },
          { label: 'Max Mach', value: `Mach ${rpy.max_mach.toFixed(3)}` },
          { label: 'Stability (Mach 0.3)', value: `${(rpy.static_margin_mach03_cal ?? 0).toFixed(2)} cal` },
          { label: 'Off-Rail Velocity', value: fmtVel(rpy.out_of_rail_velocity) },
          { label: 'Burn Time', value: `${rpy.burn_out_time_s.toFixed(2)} s` },
          { label: 'Time to Apogee', value: `${rpy.apogee_time_s.toFixed(1)} s` },
          { label: 'Landing Speed', value: rpy.impact_velocity_ms > 0 ? fmtVel(rpy.impact_velocity_ms) : '—' },
          { label: 'Main Chute Descent', value: rpy.main_descent_speed_ms > 0 ? fmtVel(rpy.main_descent_speed_ms) : '—' },
          { label: 'Drogue Descent', value: rpy.drogue_descent_speed_ms > 0 ? fmtVel(rpy.drogue_descent_speed_ms) : '—' },
          { label: 'Drift Distance', value: driftDist > 0 ? fmtDist(driftDist) : '—' },
          { label: 'FAA Waiver Radius', value: fmtDist(waiverM) },
        ].map(({ label, value }) => (
          <div key={label} className="flex items-center justify-between py-1 border-b border-gray-800/60">
            <span className="text-gray-400">{label}</span>
            <span className="text-gray-200 font-mono">{value}</span>
          </div>
        ))}
        {driftDist > 0 && (
          <div className="sm:col-span-2 flex items-center justify-center py-1.5 rounded-lg text-xs font-semibold"
            style={{ backgroundColor: waiverViolated ? 'rgba(220,38,38,0.15)' : 'rgba(22,163,74,0.15)', color: waiverViolated ? '#f87171' : '#4ade80' }}>
            {waiverViolated
              ? `⚠ DRIFT EXCEEDS FAA WAIVER (${fmtDist(driftDist)} > ${fmtDist(waiverM)})`
              : `✓ Within FAA waiver radius (${fmtDist(driftDist)} ≤ ${fmtDist(waiverM)})`}
          </div>
        )}
      </div>

      {mcImage && (
        <div>
          <h4 className="text-gray-400 text-xs mb-2">Monte Carlo Scatter (10 sims, GFS weather)</h4>
          <img src={mcImage} alt="MC scatter" className="w-full max-w-xs rounded-lg" />
        </div>
      )}

      <div className="flex items-center gap-3 pt-1">
        <button onClick={handleExport}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold px-4 py-2 rounded-lg transition-colors text-sm">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Download PDF
        </button>
        <button onClick={handleRunQuickMC} disabled={mcRunning || !selectedFile}
          className="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 text-gray-300 font-semibold px-4 py-2 rounded-lg transition-colors text-sm border border-gray-700 disabled:opacity-40">
          {mcRunning ? (
            <span className="flex items-center gap-2">
              <div className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              Running MC...
            </span>
          ) : 'Quick MC (10 sims)'}
        </button>
        <span className="text-xs text-gray-600">Includes map, stats, MC scatter</span>
      </div>
    </div>
  );
}