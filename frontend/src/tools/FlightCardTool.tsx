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
}

const M_FT = 3.28084;
const MS_FTS = 3.28084;
const N_LBF = 0.224809;
const MI_M = 1609.34;

export function FlightCardTool({ result, config, unitSystem, waiverRadiusM, hourlyLandings }: Props) {
  const imp = unitSystem === 'imperial';
  const rpy = result.rocketpy_results;
  const or_ = result.or_results;
  const params = result.rocket_params;
  const [mcImage, setMcImage] = useState<string | null>(null);
  const [mcRunning, setMcRunning] = useState(false);

  const fmtAlt = (m: number) => imp ? `${Math.round(m * M_FT).toLocaleString()} ft` : `${Math.round(m).toLocaleString()} m`;
  const fmtVel = (ms: number) => imp ? `${(ms * MS_FTS).toFixed(1)} ft/s` : `${ms.toFixed(1)} m/s`;
  const fmtMass = (kg: number) => imp ? `${(kg * 2.20462).toFixed(2)} lb` : `${kg.toFixed(3)} kg`;
  const fmtDist = (m: number) => imp ? `${(m / MI_M).toFixed(2)} mi` : `${(m / 1000).toFixed(2)} km`;

  // Drift and waiver
  const driftDist = rpy.drift_distance_m ?? 0;
  const waiverM = waiverRadiusM ?? MI_M;
  const waiverViolated = driftDist > waiverM && driftDist > 0;

  // Landing estimates
  const landings = hourlyLandings ?? result.hourly_landings ?? [];

  const handleRunQuickMC = async () => {
    setMcRunning(true);
    setMcImage(null);
    try {
      const formData = new FormData();
      formData.append('file', new Blob([], { type: 'application/octet-stream' }), 'dummy.ork');
      // Use the existing simulate endpoint to get trajectory, then run MC manually
      // We'll use the /api/monte-carlo endpoint
      const params = new URLSearchParams({
        lat: config.lat.toString(), lon: config.lon.toString(),
        elevation: config.elevation.toString(), rail_length: config.railLength.toString(),
        inclination: config.inclination.toString(), heading: config.heading.toString(),
        n_sims: '10',
        wind_speed_std_ms: '2.0',
        mass_variation_pct: '2.0',
        cd_variation_pct: '5.0',
        use_live_weather: 'true',
        sim_datetime: new Date().toISOString().slice(0, 16),
      });
      const response = await fetch(`/api/monte-carlo?${params}`, { method: 'POST' });
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
            try {
              const ev = JSON.parse(line.slice(6));
              if (ev.stage === 'done') mcResult = ev.result;
            } catch { /* skip */ }
          }
        }
      }
      if (mcResult && mcResult.landings) {
        // Generate a simple scatter image using canvas
        const canvas = document.createElement('canvas');
        canvas.width = 400;
        canvas.height = 300;
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#111827';
        ctx.fillRect(0, 0, 400, 300);
        // Compute bounds
        const lats = mcResult.landings.map((p: any) => p.lat);
        const lons = mcResult.landings.map((p: any) => p.lon);
        const minLat = Math.min(...lats, config.lat) - 0.001;
        const maxLat = Math.max(...lats, config.lat) + 0.001;
        const minLon = Math.min(...lons, config.lon) - 0.001;
        const maxLon = Math.max(...lons, config.lon) + 0.001;
        const scaleX = (lon: number) => 20 + (lon - minLon) / (maxLon - minLon || 0.001) * 360;
        const scaleY = (lat: number) => 280 - (lat - minLat) / (maxLat - minLat || 0.001) * 260;
        // Draw waiver circle
        ctx.strokeStyle = '#ef4444';
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 1.5;
        const cX = scaleX(config.lon);
        const cY = scaleY(config.lat);
        const edgeX = scaleX(config.lon + (waiverM / 111111) / Math.cos(config.lat * Math.PI / 180));
        ctx.beginPath();
        ctx.arc(cX, cY, edgeX - cX, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.setLineDash([]);
        // Draw launch point
        ctx.fillStyle = '#3b82f6';
        ctx.beginPath();
        ctx.arc(cX, cY, 5, 0, 2 * Math.PI);
        ctx.fill();
        // Draw landing scatter
        ctx.fillStyle = '#f59e0b88';
        for (const pt of mcResult.landings) {
          ctx.beginPath();
          ctx.arc(scaleX(pt.lon), scaleY(pt.lat), 3, 0, 2 * Math.PI);
          ctx.fill();
        }
        // Labels
        ctx.fillStyle = '#9ca3af';
        ctx.font = '10px monospace';
        ctx.fillText('MC 10-sim scatter', 10, 15);
        ctx.fillText(`${mcResult.n_success ?? '?'}/${mcResult.n_total ?? 10}`, 340, 15);
        setMcImage(canvas.toDataURL('image/png'));
      }
    } catch {
      setMcImage(null);
    } finally {
      setMcRunning(false);
    }
  };

  const handleExport = async () => {
    const { jsPDF } = await import('jspdf');
    const autoTable = (await import('jspdf-autotable')).default;

    const doc = new jsPDF({ unit: 'mm', format: 'letter' });
    const W = doc.internal.pageSize.getWidth();

    // Header bar
    doc.setFillColor(17, 24, 39);
    doc.rect(0, 0, W, 22, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.text('FLIGHT CARD', 14, 12);
    doc.setFontSize(9);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(156, 163, 175);
    doc.text('Generated by RocketBridge', 14, 18);
    doc.text(new Date().toLocaleString(), W - 14, 18, { align: 'right' });

    let y = 30;

    // Motor / rocket summary
    doc.setTextColor(30, 30, 30);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text(params?.motor_designation || 'Unknown Motor', 14, y);
    y += 5;
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100, 100, 100);
    if (params) {
      doc.text(
        `Length: ${(params.length_m * (imp ? 39.3701 : 100)).toFixed(1)} ${imp ? 'in' : 'cm'}   ` +
        `Diameter: ${(params.diameter_m * (imp ? 39.3701 : 1000)).toFixed(1)} ${imp ? 'in' : 'mm'}   ` +
        `Wet mass: ${fmtMass(params.wet_mass_kg)}   ` +
        `Propellant: ${fmtMass(params.propellant_mass_kg)}`,
        14, y
      );
      y += 5;
    }
    doc.text(
      `Launch site: ${config.lat.toFixed(4)}, ${config.lon.toFixed(4)}   ` +
      `Elevation: ${imp ? Math.round(config.elevation * M_FT) + ' ft' : Math.round(config.elevation) + ' m'}   ` +
      `Rail: ${imp ? (config.railLength * M_FT).toFixed(1) + ' ft' : config.railLength.toFixed(1) + ' m'}   ` +
      `${config.inclination}° / ${config.heading}°`,
      14, y
    );
    y += 8;

    // Stats table — fixed burn time row
    const rows: [string, string, string][] = [
      ['Apogee AGL',         fmtAlt(rpy.apogee_m_agl),                or_ && or_.apogee_m_agl != null ? fmtAlt(or_.apogee_m_agl) : '—'],
      ['Max Velocity',       fmtVel(rpy.max_speed_ms),                or_ && or_.max_velocity_ms != null ? fmtVel(or_.max_velocity_ms) : '—'],
      ['Max Mach',           `Mach ${rpy.max_mach.toFixed(3)}`,        or_ && or_.max_mach != null ? `Mach ${or_.max_mach.toFixed(3)}` : '—'],
      ['Stability Margin (Mach 0.3)',   `${(rpy.static_margin_mach03_cal ?? 0).toFixed(2)} cal`, or_ && or_.stability_margin_mach03_cal != null ? `${or_.stability_margin_mach03_cal.toFixed(2)} cal` : '—'],
      ['Off-Rail Velocity',  fmtVel(rpy.out_of_rail_velocity),         or_ && or_.velocity_off_rail_ms != null ? fmtVel(or_.velocity_off_rail_ms) : '—'],
      ['Burn Time',          `${rpy.burn_out_time_s.toFixed(2)} s`,    '—'],
      ['Time to Apogee',     `${rpy.apogee_time_s.toFixed(1)} s`,      or_ && or_.time_to_apogee_s != null ? `${or_.time_to_apogee_s.toFixed(1)} s` : '—'],
      ['Landing Speed',      fmtVel(rpy.impact_velocity_ms),          '—'],
      ['Main Chute Descent', rpy.main_descent_speed_ms > 0 ? fmtVel(rpy.main_descent_speed_ms) : '—',  or_ && or_.main_descent_speed_ms != null ? fmtVel(or_.main_descent_speed_ms) : '—'],
      ['Drogue Descent',     rpy.drogue_descent_speed_ms > 0 ? fmtVel(rpy.drogue_descent_speed_ms) : '—',  or_ && or_.drogue_descent_speed_ms != null ? fmtVel(or_.drogue_descent_speed_ms) : '—'],
      ['Drift Distance',     driftDist > 0 ? fmtDist(driftDist) : '—',  '—'],
      ['FAA Waiver Radius',  fmtDist(waiverM),                         '—'],
      ['Waiver Status',      waiverViolated ? 'EXCEEDS WAIVER' : 'Within waiver', '—'],
      ['Weather',            rpy.weather_source === 'standard_atmosphere' ? 'Std Atmosphere' : 'NOMADS GFS', '—'],
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
        // Highlight waiver violation row
        if (data.row.index === rows.length - 1 && data.column.index > 0) {
          if (waiverViolated) {
            data.cell.styles.textColor = [220, 38, 38];
            data.cell.styles.fontStyle = 'bold';
          } else {
            data.cell.styles.textColor = [22, 163, 74];
          }
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

    // Hourly landings table
    if (landings.length > 0) {
      autoTable(doc, {
        startY: y,
        head: [['Forecast Hour', 'Lat', 'Lon']],
        body: landings.map(l => [
          new Date(l.hour).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
          l.lat.toFixed(5),
          l.lon.toFixed(5),
        ]),
        theme: 'grid',
        headStyles: { fillColor: [17, 24, 39], textColor: [255, 255, 255], fontSize: 7, fontStyle: 'bold' },
        bodyStyles: { fontSize: 7, textColor: [30, 30, 30] },
        margin: { left: 14, right: 14 },
      });
      y = (doc as any).lastAutoTable.finalY + 6;
    }

    // MC scatter image
    if (mcImage) {
      try {
        doc.addImage(mcImage, 'PNG', 14, y, 80, 60);
        y += 64;
      } catch { /* skip */ }
    }

    // Warnings (at the bottom, below diagram and landings)
    if (result.warnings && result.warnings.length > 0) {
      doc.setFontSize(7);
      doc.setTextColor(180, 80, 0);
      result.warnings.forEach((w, i) => doc.text(`⚠ ${w}`, 14, y + i * 4));
    }

    // Footer
    const pageH = doc.internal.pageSize.getHeight();
    doc.setFillColor(17, 24, 39);
    doc.rect(0, pageH - 10, W, 10, 'F');
    doc.setFontSize(7);
    doc.setTextColor(156, 163, 175);
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
          { label: 'Stability Margin (Mach 0.3)', value: `${(rpy.static_margin_mach03_cal ?? 0).toFixed(2)} cal` },
          { label: 'Off-Rail Velocity', value: fmtVel(rpy.out_of_rail_velocity) },
          { label: 'Burn Time', value: `${rpy.burn_out_time_s.toFixed(2)} s` },
          { label: 'Time to Apogee', value: `${rpy.apogee_time_s.toFixed(1)} s` },
          { label: 'Landing Speed', value: rpy.impact_velocity_ms > 0 ? fmtVel(rpy.impact_velocity_ms) : '—' },
          { label: 'Main Chute Descent', value: rpy.main_descent_speed_ms > 0 ? fmtVel(rpy.main_descent_speed_ms) : '—' },
          { label: 'Drogue Descent', value: rpy.drogue_descent_speed_ms > 0 ? fmtVel(rpy.drogue_descent_speed_ms) : '—' },
          { label: 'Drift Distance', value: driftDist > 0 ? fmtDist(driftDist) : '—' },
          { label: 'FAA Waiver Radius', value: fmtDist(waiverM) },
          { label: 'Launch Site', value: `${config.lat.toFixed(4)}, ${config.lon.toFixed(4)}` },
        ].map(({ label, value }) => (
          <div key={label} className="flex items-center justify-between py-1 border-b border-gray-800/60">
            <span className="text-gray-400">{label}</span>
            <span className="text-gray-200 font-mono">{value}</span>
          </div>
        ))}
        {/* Waiver violation flag */}
        {driftDist > 0 && (
          <div className="sm:col-span-2 flex items-center justify-center py-1.5 rounded-lg text-xs font-semibold"
            style={{
              backgroundColor: waiverViolated ? 'rgba(220,38,38,0.15)' : 'rgba(22,163,74,0.15)',
              color: waiverViolated ? '#f87171' : '#4ade80',
            }}
          >
            {waiverViolated
              ? `⚠ DRIFT EXCEEDS FAA WAIVER (${fmtDist(driftDist)} > ${fmtDist(waiverM)})`
              : `✓ Within FAA waiver radius (${fmtDist(driftDist)} ≤ ${fmtDist(waiverM)})`}
          </div>
        )}
      </div>

      {/* Hourly landings table */}
      {landings.length > 0 && (
        <div className="text-xs">
          <h4 className="text-gray-400 mb-2">Landings by Forecast Hour</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-700 uppercase text-[10px]">
                  <th className="text-left py-1 pr-4">Hour</th>
                  <th className="text-right py-1 px-2">Lat</th>
                  <th className="text-right py-1 px-2">Lon</th>
                </tr>
              </thead>
              <tbody>
                {landings.map((l, i) => (
                  <tr key={i} className="border-b border-gray-800/40">
                    <td className="py-0.5 pr-4 text-gray-300">{new Date(l.hour).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                    <td className="py-0.5 px-2 text-right font-mono text-gray-400">{l.lat.toFixed(5)}</td>
                    <td className="py-0.5 px-2 text-right font-mono text-gray-400">{l.lon.toFixed(5)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* MC scatter image */}
      {mcImage && (
        <div>
          <h4 className="text-gray-400 text-xs mb-2">Monte Carlo Scatter (10 sims, GFS weather)</h4>
          <img src={mcImage} alt="MC scatter" className="w-full max-w-xs rounded-lg" />
        </div>
      )}

      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={handleExport}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white font-semibold px-4 py-2 rounded-lg transition-colors text-sm"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Download PDF
        </button>
        <button
          onClick={handleRunQuickMC}
          disabled={mcRunning}
          className="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 text-gray-300 font-semibold px-4 py-2 rounded-lg transition-colors text-sm border border-gray-700 disabled:opacity-40"
        >
          {mcRunning ? (
            <span className="flex items-center gap-2">
              <div className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              Running MC...
            </span>
          ) : 'Quick MC (10 sims)'}
        </button>
        <span className="text-xs text-gray-600">Includes rocket diagram, stats, warnings, landings, MC scatter</span>
      </div>
    </div>
  );
}