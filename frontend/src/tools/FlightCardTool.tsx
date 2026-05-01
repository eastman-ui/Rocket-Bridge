import { useState } from 'react';
import type { ComparisonResponse, HourlyLanding } from '../types';
import type { LaunchConfig } from '../components/LaunchConfig';
import type { UnitSystem } from '../components/TimeSeriesCharts';
import type { WeatherData } from '../components/WeatherPanel';

interface Props {
  result: ComparisonResponse;
  config: LaunchConfig;
  unitSystem: UnitSystem;
  waiverRadiusM?: number;
  hourlyLandings?: HourlyLanding[];
  selectedFile?: File | null;
  mapContainerRef?: HTMLDivElement | null;
  weatherData?: WeatherData;
}

const M_FT = 3.28084;
const MS_FTS = 3.28084;
const MI_M = 1609.34;

export function FlightCardTool({ result, config, unitSystem, waiverRadiusM, selectedFile, mapContainerRef, weatherData }: Props) {
  const imp = unitSystem === 'imperial';
  const rpy = result.rocketpy_results;
  const or_ = result.or_results;
  const params = result.rocket_params;
  const [mcImage, setMcImage] = useState<string | null>(null);
  const [mcRunning, setMcRunning] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [exportCfg, setExportCfg] = useState({
    showStats: true,
    showVehicle: true,
    showMC: true,
    showTrajectory: true,
    showWind: true,
    showCloud: true,
  });
  const toggleCfg = (key: keyof typeof exportCfg) => setExportCfg(c => ({ ...c, [key]: !c[key] }));

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
        // Generate MC scatter image using Leaflet map with ESRI satellite tiles (same as TrajectoryMap)
        const lats = mcResult.landings.map((p: any) => p.lat);
        const lons = mcResult.landings.map((p: any) => p.lon);
        const waiverDegLat = waiverM / 111111;
        const waiverDegLon = waiverM / (111111 * Math.cos(config.lat * Math.PI / 180));
        const minLat = Math.min(...lats, config.lat - waiverDegLat * 1.15) - 0.003;
        const maxLat = Math.max(...lats, config.lat + waiverDegLat * 1.15) + 0.003;
        const minLon = Math.min(...lons, config.lon - waiverDegLon * 1.15) - 0.003;
        const maxLon = Math.max(...lons, config.lon + waiverDegLon * 1.15) + 0.003;

        try {
          const L = (await import('leaflet')).default;
          const mapDiv = document.createElement('div');
          mapDiv.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:560px;z-index:9999;overflow:hidden;';
          document.body.appendChild(mapDiv);

          // Pre-compute zoom before map creation — avoids setView/fitBounds repositioning
          const proj = L.CRS.EPSG3857;
          let targetZoom = 16;
          const pad = 55;
          for (let z = 16; z >= 1; z--) {
            const sw = proj.latLngToPoint(L.latLng(minLat, minLon), z);
            const ne = proj.latLngToPoint(L.latLng(maxLat, maxLon), z);
            const bw = Math.abs(ne.x - sw.x);
            const bh = Math.abs(ne.y - sw.y);
            if (bw <= 800 - 2 * pad && bh <= 560 - 2 * pad) {
              targetZoom = z;
              break;
            }
          }

          const map = L.map(mapDiv, {
            center: [config.lat, config.lon],
            zoom: targetZoom,
            zoomControl: false,
            attributionControl: false,
            zoomAnimation: false,
            preferCanvas: true,
          });

          // ESRI satellite tiles + label overlay (same as TrajectoryMap)
          L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            maxZoom: 19,
          }).addTo(map);
          L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
            maxZoom: 19, opacity: 0.7,
          }).addTo(map);
          // Waiver circle
          L.circle([config.lat, config.lon], {
            radius: waiverM,
            color: '#ef4444',
            weight: 2,
            dashArray: '8 6',
            fillColor: '#ef4444',
            fillOpacity: 0.06,
          }).bindPopup(`<b>FAA Waiver Radius</b><br>${imp ? `${(waiverM * M_FT / 5280).toFixed(1)} mi` : `${(waiverM / 1000).toFixed(1)} km`}`).addTo(map);
          // Launch point marker (matching TrajectoryMap style)
          L.marker([config.lat, config.lon], {
            icon: L.divIcon({
              className: '',
              html: `<div style="width:12px;height:12px;background:#34d399;border-radius:50%;border:2px solid #fff;box-shadow:0 0 4px rgba(0,0,0,.5)"></div>`,
              iconSize: [12, 12],
              iconAnchor: [6, 6],
            }),
          }).addTo(map);
          // Landing scatter (matching TrajectoryMap style)
          for (const pt of mcResult.landings) {
            L.marker([pt.lat, pt.lon], {
              icon: L.divIcon({
                className: '',
                html: `<div style="width:9px;height:9px;background:#f59e0b;border-radius:50%;border:2px solid #fff;box-shadow:0 0 3px rgba(0,0,0,.5)"></div>`,
                iconSize: [9, 9],
                iconAnchor: [4.5, 4.5],
              }),
            }).addTo(map);
          }
          // Wait for tiles to load — no fitBounds, no invalidateSize
          await new Promise<void>(resolve => {
            let done = false;
            const finish = () => { if (!done) { done = true; resolve(); } };
            map.once('load', () => setTimeout(finish, 800));
            setTimeout(finish, 6000); // safety
          });
          await new Promise(r => setTimeout(r, 1000));
          // Capture
          const h2c = (await import('html2canvas')).default;
          const captureCanvas = await h2c(mapDiv, { useCORS: true, allowTaint: true, backgroundColor: '#1a1a2e', scale: 2 });
          const CW = 800, CH = 560;
          const canvas = document.createElement('canvas');
          canvas.width = CW * 2; canvas.height = CH * 2;
          const ctx = canvas.getContext('2d')!;
          ctx.scale(2, 2);
          ctx.drawImage(captureCanvas, 0, 0, CW, CH);
          // Overlay labels
          ctx.fillStyle = '#e5e7eb'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'left';
          ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 3;
          ctx.fillText('Monte Carlo Scatter', 10, 18);
          ctx.font = '11px sans-serif';
          ctx.fillText(`${mcResult.n_success ?? '?'}/${mcResult.n_total ?? 10} success`, 170, 18);
          ctx.fillStyle = '#f59e0b'; ctx.fillText(`95th pctl drift: ${fmtDist(p95)}`, 10, CH - 8);
          ctx.fillStyle = '#ef4444'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'right';
          ctx.fillText(`${imp ? `${(waiverM * M_FT / 5280).toFixed(1)} mi` : `${(waiverM / 1000).toFixed(1)} km`} waiver`, CW - 10, 18);
          ctx.shadowBlur = 0;
          setMcImage(canvas.toDataURL('image/png'));
          map.remove();
          document.body.removeChild(mapDiv);
        } catch {
          // Fallback: draw without map tiles
          const CW = 800, CH = 560;
          const canvas = document.createElement('canvas');
          canvas.width = CW; canvas.height = CH;
          const ctx = canvas.getContext('2d')!;
          ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, CW, CH);
          const pad = 55;
          const plotW = CW - 2 * pad;
          const plotH = CH - 2 * pad;
          const sx = (lon: number) => pad + (lon - minLon) / (maxLon - minLon || 0.001) * plotW;
          const sy = (lat: number) => pad + plotH - (lat - minLat) / (maxLat - minLat || 0.001) * plotH;
          ctx.fillStyle = '#111827'; ctx.fillRect(pad, pad, plotW, plotH);
          ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.lineWidth = 1; ctx.setLineDash([]);
          ctx.strokeRect(pad, pad, plotW, plotH);
          const cX = sx(config.lon), cY = sy(config.lat);
          const edgeX = sx(config.lon + waiverDegLon);
          ctx.strokeStyle = '#ef4444'; ctx.setLineDash([8, 6]); ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(cX, cY, edgeX - cX, 0, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]);
          ctx.fillStyle = '#ef4444'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
          ctx.fillText(`${imp ? `${(waiverM * M_FT / 5280).toFixed(1)} mi` : `${(waiverM / 1000).toFixed(1)} km`} waiver`, cX, cY - (edgeX - cX) - 8);
          ctx.fillStyle = '#34d399'; ctx.beginPath(); ctx.arc(cX, cY, 6, 0, 2 * Math.PI); ctx.fill();
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
          ctx.fillStyle = '#93c5fd'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'left';
          ctx.fillText('Launch', cX + 10, cY + 4);
          ctx.fillStyle = '#f59e0bcc';
          for (const pt of mcResult.landings) { ctx.beginPath(); ctx.arc(sx(pt.lon), sy(pt.lat), 4.5, 0, 2 * Math.PI); ctx.fill(); }
          ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 1;
          for (const pt of mcResult.landings) { ctx.beginPath(); ctx.arc(sx(pt.lon), sy(pt.lat), 4.5, 0, 2 * Math.PI); ctx.stroke(); }
          ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 0.5; ctx.setLineDash([]);
          const latStep = Math.max(0.001, Math.round((maxLat - minLat) / 5 * 10000) / 10000);
          const lonStep = Math.max(0.001, Math.round((maxLon - minLon) / 5 * 10000) / 10000);
          ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
          for (let lat = Math.ceil(minLat / latStep) * latStep; lat <= maxLat; lat += latStep) {
            const py = sy(lat); ctx.beginPath(); ctx.moveTo(pad, py); ctx.lineTo(CW - pad, py); ctx.stroke();
            ctx.fillText(lat.toFixed(4), CW - pad + 2, py + 3);
          }
          ctx.textAlign = 'left';
          for (let lon = Math.ceil(minLon / lonStep) * lonStep; lon <= maxLon; lon += lonStep) {
            const px = sx(lon); ctx.beginPath(); ctx.moveTo(px, pad); ctx.lineTo(px, CH - pad); ctx.stroke();
            ctx.fillText(lon.toFixed(4), px - 14, CH - pad + 14);
          }
          ctx.fillStyle = '#e5e7eb'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'left';
          ctx.fillText('Monte Carlo Scatter', pad, pad - 10);
          ctx.font = '11px sans-serif';
          ctx.fillText(`${mcResult.n_success ?? '?'}/${mcResult.n_total ?? 10} success`, pad + 160, pad - 10);
          ctx.fillStyle = '#f59e0b'; ctx.fillText(`95th pctl drift: ${fmtDist(p95)}`, pad, CH - pad + 28);
          setMcImage(canvas.toDataURL('image/png'));
        }
      }
    } catch { setMcImage(null); }
    finally { setMcRunning(false); }
  };

  // ── Helpers for weather data ──
  const P_LEVELS = [1000, 925, 850, 700, 500, 400, 300, 250, 200, 150, 100, 70, 50, 30, 20, 10] as const;
  function pToAltM(hPa: number): number {
    const T0 = 288.15, L = 0.0065, P0 = 1013.25, g = 9.80665, R = 287.05;
    return Math.max(0, (T0 / L) * (1 - Math.pow(hPa / P0, (R * L) / g)));
  }
  function degToCompass(deg: number): string {
    const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                   'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return dirs[Math.round(deg / 22.5) % 16];
  }
  function hslToRgb(h: number, s: number, l: number): [number, number, number] {
    s /= 100; l /= 100;
    const k = (n: number) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
  }
  function cloudTerm(pct: number): string {
    if (pct < 5)  return 'CLR';
    if (pct < 25) return 'FEW';
    if (pct < 50) return 'SCT';
    if (pct < 88) return 'BKN';
    return 'OVC';
  }
  const handleExport = async () => {
    const { jsPDF } = await import('jspdf');
    const autoTable = (await import('jspdf-autotable')).default;
    const html2canvas = (await import('html2canvas')).default;

    const doc = new jsPDF({ unit: 'mm', format: 'letter' });
    const W = doc.internal.pageSize.getWidth();
    const H = doc.internal.pageSize.getHeight();
    const LM = 14;
    const RM = 14;
    const CW = W - LM - RM;

    const footer = (pageH: number) => {
      doc.setFillColor(15, 23, 42); doc.rect(0, pageH - 10, W, 10, 'F');
      doc.setFillColor(59, 130, 246); doc.rect(0, pageH - 10, W, 0.8, 'F');
      doc.setFontSize(6.5); doc.setTextColor(148, 163, 184);
      doc.text('RocketBridge · rocketpy + openrocket comparison', LM, pageH - 3.5);
      doc.text(`Simulated ${new Date().toLocaleDateString()}`, W - RM, pageH - 3.5, { align: 'right' });
    };

    // Determine which page-2 sections are enabled
    const hasPage2Content = (exportCfg.showMC && mcImage) || (exportCfg.showTrajectory && mapContainerRef) || (exportCfg.showWind && weatherData) || (exportCfg.showCloud && weatherData);

    // ═══════════════════════ PAGE 1 ═══════════════════════
    // ── Header band ──
    doc.setFillColor(15, 23, 42); doc.rect(0, 0, W, 26, 'F');
    doc.setFillColor(59, 130, 246); doc.rect(0, 26, W, 1.2, 'F');
    doc.setTextColor(255, 255, 255); doc.setFontSize(18); doc.setFont('helvetica', 'bold');
    doc.text('FLIGHT CARD', LM, 11);
    doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(148, 163, 184);
    doc.text('Generated by RocketBridge', LM, 19);
    doc.text(new Date().toLocaleString(), W - RM, 19, { align: 'right' });

    let y = 32;

    // ── Waiver status ──
    if (driftDist > 0) {
      const bgColor = waiverViolated ? [254, 226, 226] : [220, 252, 231];
      const fgColor = waiverViolated ? [185, 28, 28] : [21, 128, 61];
      const label = waiverViolated ? 'Exceeds Waiver' : 'In Waiver';
      doc.setFontSize(7.5); doc.setFont('helvetica', 'bold');
      const tw = doc.getTextWidth(label);
      const pillW = tw + 10;
      const pillH = 6;
      const pillX = (W - pillW) / 2;
      doc.setFillColor(bgColor[0], bgColor[1], bgColor[2]);
      doc.roundedRect(pillX, y, pillW, pillH, 1.5, 1.5, 'F');
      doc.setTextColor(fgColor[0], fgColor[1], fgColor[2]);
      doc.text(label, W / 2, y + pillH / 2 + 1, { align: 'center' });
      y += pillH + 4;
    }

    // ── Motor summary line ──
    doc.setTextColor(30, 30, 30); doc.setFontSize(12); doc.setFont('helvetica', 'bold');
    doc.text(params?.motor_designation || 'Unknown Motor', LM, y);
    if (params) {
      y += 4.5; doc.setFontSize(7.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(120, 120, 120);
      doc.text(`Length: ${(params.length_m * (imp ? 39.3701 : 100)).toFixed(1)} ${imp ? 'in' : 'cm'}    Diameter: ${(params.diameter_m * (imp ? 39.3701 : 1000)).toFixed(1)} ${imp ? 'in' : 'mm'}    Wet mass: ${imp ? (params.wet_mass_kg * 2.20462).toFixed(2) + ' lb' : params.wet_mass_kg.toFixed(3) + ' kg'}`, LM, y);
    }
    y += 5;

    // ── Launch Configuration (horizontal) ──
    doc.setFontSize(7); doc.setFont('helvetica', 'normal'); doc.setTextColor(80, 80, 80);
    const elevStr = `${imp ? Math.round(config.elevation * M_FT) : Math.round(config.elevation)} ${imp ? 'ft' : 'm'}`;
    doc.text(`Lat: ${config.lat.toFixed(5)} · Lon: ${config.lon.toFixed(5)} · Elev: ${elevStr} · Rail: ${config.railLength} ${imp ? 'ft' : 'm'} · ${config.inclination}° · ${config.heading}°`, LM, y);
    y += 7;

    // ── Section: Key Statistics ──
    if (exportCfg.showStats) {
      doc.setFillColor(241, 245, 249); doc.rect(LM, y, CW, 5.5, 'F');
      doc.setFontSize(7); doc.setFont('helvetica', 'bold'); doc.setTextColor(100, 116, 139);
      doc.text('KEY STATISTICS', LM + 2, y + 3.8);
      y += 7;

      const rows = ([
        ['Apogee AGL', fmtAlt(rpy.apogee_m_agl), or_?.apogee_m_agl != null ? fmtAlt(or_.apogee_m_agl) : '—'],
        ['Max Velocity', fmtVel(rpy.max_speed_ms), or_?.max_velocity_ms != null ? fmtVel(or_.max_velocity_ms!) : '—'],
        ['Max Mach', `Mach ${rpy.max_mach.toFixed(3)}`, or_?.max_mach != null ? `Mach ${or_.max_mach!.toFixed(3)}` : '—'],
        ['Stability (Mach 0.3)', `${(rpy.static_margin_mach03_cal ?? 0).toFixed(2)} cal`, or_?.stability_margin_mach03_cal != null ? `${or_.stability_margin_mach03_cal!.toFixed(2)} cal` : '—'],
        ['Off-Rail Velocity', fmtVel(rpy.out_of_rail_velocity), or_?.velocity_off_rail_ms != null ? fmtVel(or_.velocity_off_rail_ms!) : '—'],
        ['Burn Time', `${rpy.burn_out_time_s.toFixed(2)} s`, '—'],
        ['Time to Apogee', `${rpy.apogee_time_s.toFixed(1)} s`, or_?.time_to_apogee_s != null ? `${or_.time_to_apogee_s!.toFixed(1)} s` : '—'],
        ['Drift Distance', driftDist > 0 ? fmtDist(driftDist) : '—', '—'],
        ['FAA Waiver Radius', fmtDist(waiverM), '—'],
      ] as [string, string, string][]).filter(r => r[1] !== '—' || r[2] !== '—');

      const tableW = 50 + 55 + 55;
      const tableLM = (W - tableW) / 2;
      autoTable(doc, {
        startY: y,
        head: [['Parameter', 'RocketPy', 'OpenRocket']],
        body: rows,
        theme: 'grid',
        headStyles: { fillColor: [15, 23, 42], textColor: [255, 255, 255], fontSize: 7.5, fontStyle: 'bold', cellPadding: { top: 2, bottom: 2, left: 3, right: 3 } },
        bodyStyles: { fontSize: 7.5, textColor: [30, 30, 30], cellPadding: { top: 1.8, bottom: 1.8, left: 3, right: 3 } },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        columnStyles: { 0: { fontStyle: 'bold', cellWidth: 50 }, 1: { cellWidth: 55, halign: 'right' }, 2: { cellWidth: 55, halign: 'right' } },
        margin: { left: tableLM, right: tableLM },
      });
      y = (doc as any).lastAutoTable.finalY + 6;
    }

    // ── Vehicle Profile (centered full-width rocket diagram) ──
    if (exportCfg.showVehicle && result.rocket_diagram) {
      const imgW = CW * 0.85;
      const imgH = imgW * 0.37;
      const imgX = LM + (CW - imgW) / 2; // centered
      doc.setFillColor(241, 245, 249); doc.rect(LM, y, CW, 5.5, 'F');
      doc.setFontSize(7); doc.setFont('helvetica', 'bold'); doc.setTextColor(100, 116, 139);
      doc.text('VEHICLE PROFILE', LM + 2, y + 3.8);
      y += 7;
      try {
        doc.addImage(`data:image/png;base64,${result.rocket_diagram}`, 'PNG', imgX, y, imgW, imgH);
      } catch { /* skip */ }
      y += imgH + 6;
    }

    footer(H);

    if (!hasPage2Content) {
      doc.save(`flight-card-${params?.motor_designation || 'rocket'}.pdf`);
      return;
    }

    // ═══════════════════════ PAGE 2 ═══════════════════════
    doc.addPage();
    let y2 = 14;

    // ── MC scatter image ──
    if (exportCfg.showMC && mcImage) {
      const sectionH = 5.5;
      doc.setFillColor(241, 245, 249); doc.rect(LM, y2, CW, sectionH, 'F');
      doc.setFontSize(7); doc.setFont('helvetica', 'bold'); doc.setTextColor(100, 116, 139);
      doc.text('MONTE CARLO DISPERSION (10 sims, GFS weather)', LM + 2, y2 + 3.8);
      y2 += sectionH + 1.5;
      try {
        const mcW = CW;
        const mcH = mcW * 0.7;
        doc.addImage(mcImage, 'PNG', LM, y2, mcW, mcH);
        y2 += mcH + 4;
      } catch { /* skip */ }
    }

    // ── Map screenshot ──
    if (exportCfg.showTrajectory && mapContainerRef) {
      const sectionH = 5.5;
      doc.setFillColor(241, 245, 249); doc.rect(LM, y2, CW, sectionH, 'F');
      doc.setFontSize(7); doc.setFont('helvetica', 'bold'); doc.setTextColor(100, 116, 139);
      doc.text('TRAJECTORY MAP', LM + 2, y2 + 3.8);
      y2 += sectionH + 1.5;
      try {
        const canvas = await html2canvas(mapContainerRef, { useCORS: true, allowTaint: true, backgroundColor: '#111827', scale: 2 });
        const imgData = canvas.toDataURL('image/png');
        const mapW = CW;
        const mapH = mapW * 0.4;
        doc.addImage(imgData, 'PNG', LM, y2, mapW, mapH);
        y2 += mapH + 4;
      } catch { /* skip if map capture fails */ }
    }

    // ── Wind + Cloud section ──
    if ((exportCfg.showWind || exportCfg.showCloud) && weatherData) {
      const hourly = weatherData.hourly;
      const siteElevM = weatherData.elevation ?? config.elevation;
      const launchHour = new Date().toISOString().slice(0, 16);
      let hourIdx = (hourly.time as string[]).findIndex(t => t === launchHour);
      if (hourIdx < 0) hourIdx = 0;

      // ── Build wind data ──
      const altsFt: number[] = [];
      const speeds: number[] = [];
      const dirs: number[] = [];
      const surfSpeed = (hourly.windspeed_10m as number[])[hourIdx] ?? 0;
      const surfDir = (hourly.winddirection_10m as number[])[hourIdx] ?? 0;
      altsFt.push(0);
      speeds.push(surfSpeed);
      dirs.push(surfDir);
      for (const p of P_LEVELS) {
        const ws = (hourly[`windspeed_${p}hPa`] as number[])?.[hourIdx];
        const wd = (hourly[`winddirection_${p}hPa`] as number[])?.[hourIdx];
        if (ws == null || wd == null) continue;
        const gph = (hourly[`geopotential_height_${p}hPa`] as number[])?.[hourIdx];
        const altM = gph != null ? gph - siteElevM : pToAltM(p) - siteElevM;
        if (altM < 0) continue;
        altsFt.push(altM * M_FT);
        speeds.push(ws);
        dirs.push(wd);
      }
      const order = altsFt.map((_, i) => i).sort((a, b) => altsFt[a] - altsFt[b]);
      const sortedAlt = order.map(i => altsFt[i]);
      const sortedSpeed = order.map(i => speeds[i]);
      const sortedDirs = order.map(i => dirs[i]);

      // ── Build cloud data ──
      const cloudData: { alt: number; altDisplay: string; pct: number }[] = [];
      if (exportCfg.showCloud) {
        const surfCloud = (hourly.cloudcover_low as number[])[hourIdx] ?? 0;
        if (surfCloud > 0) cloudData.push({ alt: 0, altDisplay: '0', pct: Math.round(surfCloud) });
        for (const p of P_LEVELS) {
          const cc = (hourly[`cloudcover_${p}hPa`] as number[])?.[hourIdx] ?? 0;
          const gph = (hourly[`geopotential_height_${p}hPa`] as number[])?.[hourIdx];
          const altM = gph != null ? gph - siteElevM : pToAltM(p) - siteElevM;
          if (altM < 0 || cc < 1) continue;
          const altDisplay = imp ? Math.round(altM * M_FT).toLocaleString() : Math.round(altM).toLocaleString();
          cloudData.push({ alt: altM, altDisplay, pct: Math.round(cc) });
        }
        cloudData.sort((a, b) => b.alt - a.alt);
      }

      if (sortedAlt.length > 0 || cloudData.length > 0) {
        const sectionH = 5.5;
        doc.setFillColor(241, 245, 249); doc.rect(LM, y2, CW, sectionH, 'F');
        doc.setFontSize(7); doc.setFont('helvetica', 'bold'); doc.setTextColor(100, 116, 139);
        doc.text('WEATHER ALOFT', LM + 2, y2 + 3.8);
        y2 += sectionH + 1.5;

        // Layout: both enabled = side-by-side; only one = full width
        const showBoth = exportCfg.showWind && exportCfg.showCloud && sortedAlt.length > 0 && cloudData.length > 0;
        const leftW = showBoth ? CW * 0.6 : CW;
        const rightX = LM + leftW + 4;

        // ── Left: Wind aloft chart ──
        let windPdfH = 0;
        const windStartY = y2;
        if (exportCfg.showWind && sortedAlt.length > 0) {
          const CW_CANVAS = 500, CH_CANVAS = 380;
          const cvs = document.createElement('canvas');
          cvs.width = CW_CANVAS; cvs.height = CH_CANVAS;
          const ctx = cvs.getContext('2d')!;
          const padC = { l: 48, r: 80, t: 18, b: 28 };
          const plotW = CW_CANVAS - padC.l - padC.r;
          const plotH = CH_CANVAS - padC.t - padC.b;

          ctx.fillStyle = '#1f2937'; ctx.fillRect(0, 0, CW_CANVAS, CH_CANVAS);

          const displayAlts = imp ? sortedAlt : sortedAlt.map(ft => ft / M_FT);
          const maxAlt = imp ? 110000 : 33500;
          const maxSpeed = Math.ceil(Math.max(...sortedSpeed, 10) / 10) * 10;
          const altUnit = imp ? 'ft' : 'm';
          const speedUnit = imp ? 'mph' : 'km/h';

          const sxW = (s: number) => padC.l + (s / maxSpeed) * plotW;
          const syW = (a: number) => padC.t + plotH - (a / maxAlt) * plotH;

          // Grid
          ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 0.5;
          for (let a = 0; a <= maxAlt; a += maxAlt / 5) {
            const py = syW(a);
            ctx.beginPath(); ctx.moveTo(padC.l, py); ctx.lineTo(padC.l + plotW, py); ctx.stroke();
            ctx.fillStyle = '#9ca3af'; ctx.font = '9px monospace'; ctx.textAlign = 'right';
            ctx.fillText(Math.round(a).toLocaleString(), padC.l - 4, py + 3);
          }
          for (let s = 0; s <= maxSpeed; s += maxSpeed / 5) {
            const px = sxW(s);
            ctx.beginPath(); ctx.moveTo(px, padC.t); ctx.lineTo(px, padC.t + plotH); ctx.stroke();
            ctx.fillStyle = '#9ca3af'; ctx.font = '9px monospace'; ctx.textAlign = 'center';
            ctx.fillText(Math.round(s).toString(), px, padC.t + plotH + 14);
          }

          // Axis labels
          ctx.fillStyle = '#9ca3af'; ctx.font = 'bold 10px sans-serif';
          ctx.save(); ctx.translate(10, padC.t + plotH / 2); ctx.rotate(-Math.PI / 2);
          ctx.textAlign = 'center'; ctx.fillText(`Alt (${altUnit})`, 0, 0); ctx.restore();
          ctx.fillText(`Speed (${speedUnit})`, padC.l + plotW / 2, CH_CANVAS - 3);

          // Line
          ctx.strokeStyle = '#4b5563'; ctx.lineWidth = 1.5;
          ctx.beginPath();
          for (let i = 0; i < sortedSpeed.length; i++) {
            const px = sxW(sortedSpeed[i]);
            const py = syW(displayAlts[i]);
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.stroke();

          // Points + labels
          for (let i = 0; i < sortedSpeed.length; i++) {
            const px = sxW(sortedSpeed[i]);
            const py = syW(displayAlts[i]);
            const deg = sortedDirs[i];
            const rgb = hslToRgb((210 + deg) % 360, 70, 55);
            ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
            ctx.beginPath(); ctx.arc(px, py, 4, 0, 2 * Math.PI); ctx.fill();
            ctx.strokeStyle = '#1f2937'; ctx.lineWidth = 1; ctx.stroke();
            ctx.fillStyle = '#d1d5db'; ctx.font = '8px monospace'; ctx.textAlign = 'left';
            ctx.fillText(`${sortedSpeed[i].toFixed(0)} ${degToCompass(deg)}`, px + 6, py + 3);
          }

          ctx.fillStyle = '#6b7280'; ctx.font = '8px sans-serif'; ctx.textAlign = 'left';
          ctx.fillText('Color = direction', padC.l, CH_CANVAS - 3);

          const windImgData = cvs.toDataURL('image/png');
          const windPdfW = leftW;
          windPdfH = windPdfW * (CH_CANVAS / CW_CANVAS);
          doc.addImage(windImgData, 'PNG', LM, y2, windPdfW, windPdfH);
        }

        // ── Right: Cloud layers table (side-by-side with wind) ──
        if (showBoth) {
          const altLabel = imp ? 'ft' : 'm';
          doc.setFontSize(7); doc.setFont('helvetica', 'bold'); doc.setTextColor(30, 30, 30);
          doc.text(`Cloud Layers (${altLabel} AGL)`, rightX, windStartY + 2);

          const cloudRows = cloudData.map(d => {
            const term = cloudTerm(d.pct);
            const suffix = (term === 'BKN' || term === 'OVC') ? ' ▲' : '';
            return [d.altDisplay, `${d.pct}%`, term + suffix];
          });

          autoTable(doc, {
            startY: windStartY + 4,
            head: [['Alt', 'Cover', 'Term']],
            body: cloudRows as string[][],
            theme: 'grid',
            headStyles: { fillColor: [15, 23, 42], textColor: [255, 255, 255], fontSize: 6, fontStyle: 'bold', cellPadding: { top: 1, bottom: 1, left: 1.5, right: 1.5 } },
            bodyStyles: { fontSize: 6, textColor: [30, 30, 30], cellPadding: { top: 0.8, bottom: 0.8, left: 1.5, right: 1.5 } },
            columnStyles: { 0: { cellWidth: 25 }, 1: { cellWidth: 18, halign: 'right' }, 2: { cellWidth: 18, halign: 'center' } },
            margin: { left: rightX },
            didParseCell: (hookData: any) => {
              const row = hookData.row?.index;
              if (row != null && row >= 0 && row < cloudData.length) {
                const pct = cloudData[row].pct;
                const term = cloudTerm(pct);
                if (term === 'BKN' || term === 'OVC') {
                  hookData.cell.styles.fillColor = [254, 243, 199];
                }
              }
            },
          });

          const tableEndY = (doc as any).lastAutoTable.finalY;
          doc.setFontSize(5.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(156, 163, 175);
          doc.text('BKN/OVC = ceiling', rightX, tableEndY + 2);
          y2 = Math.max(y2 + (windPdfH > 0 ? windPdfH + 4 : 0), tableEndY + 4);
        } else if (windPdfH > 0) {
          y2 += windPdfH + 4;
        }

        // Cloud-only (full width, no wind)
        if (exportCfg.showCloud && !exportCfg.showWind && cloudData.length > 0) {
          const altLabel = imp ? 'ft' : 'm';
          doc.setFontSize(7); doc.setFont('helvetica', 'bold'); doc.setTextColor(30, 30, 30);
          doc.text(`Cloud Layers (${altLabel} AGL)`, LM, y2 + 2);

          const cloudRows = cloudData.map(d => {
            const term = cloudTerm(d.pct);
            const suffix = (term === 'BKN' || term === 'OVC') ? ' ▲' : '';
            return [d.altDisplay, `${d.pct}%`, term + suffix];
          });

          autoTable(doc, {
            startY: y2 + 4,
            head: [['Alt', 'Cover', 'Term']],
            body: cloudRows as string[][],
            theme: 'grid',
            headStyles: { fillColor: [15, 23, 42], textColor: [255, 255, 255], fontSize: 6, fontStyle: 'bold', cellPadding: { top: 1, bottom: 1, left: 1.5, right: 1.5 } },
            bodyStyles: { fontSize: 6, textColor: [30, 30, 30], cellPadding: { top: 0.8, bottom: 0.8, left: 1.5, right: 1.5 } },
            columnStyles: { 0: { cellWidth: 25 }, 1: { cellWidth: 18, halign: 'right' }, 2: { cellWidth: 18, halign: 'center' } },
            margin: { left: LM },
            didParseCell: (hookData: any) => {
              const row = hookData.row?.index;
              if (row != null && row >= 0 && row < cloudData.length) {
                const pct = cloudData[row].pct;
                const term = cloudTerm(pct);
                if (term === 'BKN' || term === 'OVC') {
                  hookData.cell.styles.fillColor = [254, 243, 199];
                }
              }
            },
          });

          const tableEndY = (doc as any).lastAutoTable.finalY;
          doc.setFontSize(5.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(156, 163, 175);
          doc.text('BKN/OVC = ceiling', LM, tableEndY + 2);
          y2 = tableEndY + 4;
        }
      }
    }

    footer(H);
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

      {/* Export settings */}
      <div className="border border-gray-700 rounded-lg">
        <button onClick={() => setShowSettings(!showSettings)}
          className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-gray-300 hover:bg-gray-800/50 rounded-lg transition-colors">
          <span>Export Settings</span>
          <svg className={`w-4 h-4 transition-transform ${showSettings ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {showSettings && (
          <div className="px-3 pb-3 grid grid-cols-2 sm:grid-cols-3 gap-2">
            {([
              { key: 'showStats' as const, label: 'Key Statistics' },
              { key: 'showVehicle' as const, label: 'Vehicle Profile' },
              { key: 'showMC' as const, label: 'MC Dispersion' },
              { key: 'showTrajectory' as const, label: 'Trajectory Map' },
              { key: 'showWind' as const, label: 'Wind Aloft' },
              { key: 'showCloud' as const, label: 'Cloud Layers' },
            ]).map(({ key, label }) => (
              <label key={key} className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                <input type="checkbox" checked={exportCfg[key]} onChange={() => toggleCfg(key)}
                  className="rounded border-gray-600 bg-gray-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-0" />
                {label}
              </label>
            ))}
          </div>
        )}
      </div>

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
      </div>
    </div>
  );
}