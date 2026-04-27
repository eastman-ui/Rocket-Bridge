import PlotlyImport from 'react-plotly.js';
const Plot = (PlotlyImport as any).default ?? PlotlyImport;
import type { Trajectory3D } from '../types';

interface Props {
  trajectory: Trajectory3D;
  burnOutTimeS: number;
  apogeeTimeS: number;
}

// ─── Rocket wireframe in body frame ───────────────────────────────────────────
// Body-z = nose direction (positive = nose), centered at origin, length 1.
type Pt = [number, number, number];
const NAN: Pt = [NaN, NaN, NaN];

function ring(z: number, r: number, n = 12): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return [r * Math.cos(a), r * Math.sin(a), z] as Pt;
  });
}

function buildRocketBody(): Pt[] {
  const pts: Pt[] = [];
  const R = 0.12;
  const noseZ    =  0.50;
  const nConZ    =  0.22;
  const bodyEndZ = -0.35;
  const tailZ    = -0.50;
  const finSpan  =  0.22;

  // Nose cone ribs
  for (let i = 0; i < 12; i++) {
    const a = (2 * Math.PI * i) / 12;
    pts.push([0, 0, noseZ], [R * Math.cos(a), R * Math.sin(a), nConZ], NAN);
  }
  pts.push(...ring(nConZ, R), NAN);

  // 4 body stripes
  for (let i = 0; i < 4; i++) {
    const a = (Math.PI * i) / 2;
    pts.push([R * Math.cos(a), R * Math.sin(a), nConZ],
             [R * Math.cos(a), R * Math.sin(a), bodyEndZ], NAN);
  }
  pts.push(...ring(bodyEndZ, R), NAN);

  // 4 fins (between stripes, 45° offset)
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (Math.PI * i) / 2;
    const bx = R * Math.cos(a), by = R * Math.sin(a);
    const dx = finSpan * Math.cos(a), dy = finSpan * Math.sin(a);
    pts.push(
      [bx, by, bodyEndZ + 0.08],
      [bx + dx, by + dy, bodyEndZ + 0.14],
      [bx + dx, by + dy, tailZ + 0.06],
      [bx, by, tailZ],
      [bx, by, bodyEndZ + 0.08],
      NAN,
    );
  }
  return pts;
}

const BODY_PTS = buildRocketBody();

// ─── Rotation: body-z → (nx,ny,nz) in ENU ────────────────────────────────────
function rotateToNose(pts: Pt[], nx: number, ny: number, nz: number) {
  // Build orthonormal frame: body-z = nose, body-y = horizontal perp (zero-roll)
  let rx: number, ry: number, rz: number;
  if (Math.abs(nz) < 0.95) {
    // cross(up=(0,0,1), nose): (-ny, nx, 0) — gives "right" direction
    const len = Math.sqrt(nx * nx + ny * ny) || 1;
    rx = -ny / len; ry = nx / len; rz = 0;
  } else {
    // near-vertical: cross((1,0,0), nose) = (0*nz - 0*ny, 0*nx - 1*nz, 1*ny - 0*nx) = (0, -nz, ny)
    const len = Math.sqrt(nz * nz + ny * ny) || 1;
    rx = 0; ry = -nz / len; rz = ny / len;
  }
  // body-x = cross(body-y, body-z)
  const wx = ry * nz - rz * ny;
  const wy = rz * nx - rx * nz;
  const wz = rx * ny - ry * nx;

  const x: number[] = [], y: number[] = [], z: number[] = [];
  for (const [px, py, pz] of pts) {
    if (isNaN(px)) { x.push(NaN); y.push(NaN); z.push(NaN); continue; }
    x.push(wx * px + rx * py + nx * pz);
    y.push(wy * px + ry * py + ny * pz);
    z.push(wz * px + rz * py + nz * pz);
  }
  return { x, y, z };
}

// ─── Component ────────────────────────────────────────────────────────────────
export function OrientationRender({ trajectory, burnOutTimeS, apogeeTimeS }: Props) {
  const hasOri = !!(trajectory.ux && trajectory.ux.length === trajectory.t.length);
  if (!hasOri) return null;

  const ux = trajectory.ux!;
  const uy = trajectory.uy!;
  const uz = trajectory.uz!;

  const N = trajectory.t.length;
  const step = Math.max(1, Math.floor(N / 200));
  const animIdxs = Array.from({ length: Math.ceil(N / step) }, (_, i) => Math.min(i * step, N - 1));

  // Pre-rotate rocket for every animation frame
  const rotatedFrames = animIdxs.map(idx =>
    rotateToNose(BODY_PTS, ux[idx], uy[idx], uz[idx])
  );

  const initRot = rotatedFrames[0];

  const frames: any[] = rotatedFrames.map((rot, fi) => ({
    name: String(fi),
    data: [{ x: rot.x, y: rot.y, z: rot.z }],
    traces: [1],
  }));

  const sliderSteps = animIdxs.map((idx, fi) => ({
    method: 'animate',
    label: fi % 20 === 0 ? `${trajectory.t[idx].toFixed(0)}s` : '',
    args: [[String(fi)], {
      frame: { duration: 0, redraw: true },
      mode: 'immediate',
      transition: { duration: 0 },
    }],
  }));

  // Reference: Up axis + faint ground ring
  const upAxis = {
    type: 'scatter3d', mode: 'lines',
    x: [0, 0], y: [0, 0], z: [-0.65, 0.65],
    name: 'Up',
    line: { color: '#4b5563', width: 2, dash: 'dot' },
    showlegend: false,
  };

  const groundRing = (() => {
    const r = ring(-0.5, 0.75);
    return {
      type: 'scatter3d', mode: 'lines',
      x: r.map(p => p[0]), y: r.map(p => p[1]), z: r.map(p => p[2]),
      name: 'Ground plane',
      line: { color: '#374151', width: 1 },
      showlegend: false,
    };
  })();

  const rocketTrace: any = {
    type: 'scatter3d', mode: 'lines',
    x: initRot.x, y: initRot.y, z: initRot.z,
    name: 'Rocket',
    line: { color: '#60a5fa', width: 2 },
    showlegend: false,
  };

  const data = [upAxis, rocketTrace, groundRing];

  const layout: any = {
    paper_bgcolor: '#111827',
    scene: {
      xaxis: { title: { text: 'East', font: { color: '#d1d5db', size: 12 } }, gridcolor: '#374151', backgroundcolor: '#1f2937', color: '#6b7280', range: [-0.8, 0.8], tickfont: { size: 9 } },
      yaxis: { title: { text: 'North', font: { color: '#d1d5db', size: 12 } }, gridcolor: '#374151', backgroundcolor: '#1f2937', color: '#6b7280', range: [-0.8, 0.8], tickfont: { size: 9 } },
      zaxis: { title: { text: 'Up', font: { color: '#d1d5db', size: 12 } }, gridcolor: '#374151', backgroundcolor: '#1f2937', color: '#6b7280', range: [-0.8, 0.8], tickfont: { size: 9 } },
      bgcolor: '#1f2937',
      aspectmode: 'cube',
      camera: { eye: { x: 1.6, y: 1.2, z: 0.6 } },
    },
    margin: { t: 10, r: 0, b: 110, l: 0 },
    autosize: true,
    height: 520,
    updatemenus: [{
      type: 'buttons',
      showactive: false,
      x: 0.08, xanchor: 'right',
      y: -0.07, yanchor: 'top',
      direction: 'left',
      pad: { r: 8, t: 4 },
      buttons: [
        {
          label: 'Play',
          method: 'animate',
          args: [null, { fromcurrent: true, frame: { duration: 50, redraw: true }, transition: { duration: 0 } }],
        },
        {
          label: 'Pause',
          method: 'animate',
          args: [[null], { mode: 'immediate', frame: { duration: 0, redraw: false } }],
        },
      ],
      font: { color: '#e2e8f0', size: 13 },
      bgcolor: '#374151',
      bordercolor: '#4b5563',
      borderwidth: 1,
    }],
    sliders: [{
      active: 0,
      currentvalue: { prefix: 't = ', suffix: ' s', xanchor: 'center', font: { color: '#9ca3af', size: 12 }, visible: true },
      transition: { duration: 0 },
      x: 0.1, len: 0.88,
      y: 0, yanchor: 'top',
      pad: { t: 30, b: 8 },
      steps: sliderSteps,
      font: { color: '#9ca3af', size: 9 },
      bgcolor: '#374151',
      bordercolor: '#4b5563',
      tickcolor: '#6b7280',
      activebgcolor: '#3b82f6',
    }],
  };

  return (
    <div className="bg-gray-900 rounded-xl p-4">
      <h2 className="text-sm font-semibold text-gray-300 mb-0.5 uppercase tracking-wide">Rocket Orientation</h2>
      <p className="text-gray-600 text-xs mb-3">
        Rocket attitude relative to ENU frame · press Play to animate through flight
      </p>
      <Plot
        data={data}
        layout={layout}
        frames={frames}
        config={{ responsive: true, displayModeBar: false }}
        style={{ width: '100%' }}
        useResizeHandler
      />
    </div>
  );
}
