import { useMemo, useEffect, useRef, Suspense } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import { TrackballControls } from '@react-three/drei';
import * as THREE from 'three';

// Mirror of DesignPage types (no shared module needed)
interface OrkPosition {
  method: string;
  offset: number;
  position_type: string;
  position_value: number;
}
interface OrkComponent {
  type: string;
  id: string;
  name: string;
  position?: OrkPosition;
  children?: OrkComponent[];
  [key: string]: unknown;
}
interface OrkTree {
  rocket_name: string;
  components: OrkComponent[];
}

// ── Colors ────────────────────────────────────────────────────────────────────
const C_SEL = '#60a5fa';
const C_NOSE = '#90a4ae';
const C_TUBE = '#78909c';
const C_FIN = '#b0bec5';
const C_CHUTE = '#4caf50';
const C_INTERNAL = '#ffb74d';

// ── Dimension helpers ────────────────────────────────────────────────────────
// Backend may return radius as number OR "auto 0.0781685" string
function parseNum(v: unknown, fallback = 0): number {
  if (typeof v === 'number') return isNaN(v) ? fallback : v;
  if (typeof v === 'string') {
    const s = v.replace(/^auto\s+/, '');
    const n = parseFloat(s);
    return isNaN(n) ? fallback : n;
  }
  return fallback;
}

// ── Nosecone profile ─────────────────────────────────────────────────────────
// Returns [radius, height] points from base (y=0) to tip (y=L) for LatheGeometry.
function noseconeProfile(shape: string, L: number, R: number): THREE.Vector2[] {
  const N = 32;
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N; // 0 = base, 1 = tip
    let r: number;
    switch (shape) {
      case 'conical':
        r = R * (1 - t);
        break;
      case 'ogive':
      case 'vonkarman':
      case 'haack': {
        // Von Kármán Haack series (C=0)
        const s = 1 - t; // s: 1 at base → 0 at tip
        if (s < 1e-9) { r = 0; break; }
        const theta = Math.acos(1 - 2 * s);
        const v = theta - Math.sin(2 * theta) / 2;
        r = (R / Math.sqrt(Math.PI)) * Math.sqrt(Math.max(0, v));
        break;
      }
      case 'elliptical':
        r = R * Math.sqrt(Math.max(0, 1 - t * t));
        break;
      case 'parabolic':
        r = R * (1 - t * t);
        break;
      default:
        r = R * (1 - t);
    }
    pts.push(new THREE.Vector2(Math.max(0, r), t * L));
  }
  return pts;
}

// ── Render item ───────────────────────────────────────────────────────────────
interface RenderItem {
  id: string;
  type: string;
  comp: OrkComponent;
  yBottom: number;
  yTop: number;
  radius: number;
  parentRadius?: number;
}

// ── Build render list from tree ───────────────────────────────────────────────
function buildRenderList(tree: OrkTree): RenderItem[] {
  const items: RenderItem[] = [];
  const stageComps = tree.components[0]?.children ?? [];

  let totalLen = 0;
  for (const c of stageComps) {
    if (['nosecone', 'bodytube', 'tubecoupler'].includes(c.type))
      totalLen += parseNum(c.length, 0);
  }

  let yTop = totalLen;

  for (const comp of stageComps) {
    if (!['nosecone', 'bodytube', 'tubecoupler'].includes(comp.type)) continue;
    const len = parseNum(comp.length, 0);
    const radius =
      parseNum(comp.radius, 0) ||
      parseNum(comp.aftradius, 0) ||
      parseNum(comp.outerradius, 0) ||
      0.05;
    const yBottom = yTop - len;

    items.push({ id: comp.id, type: comp.type, comp, yBottom, yTop, radius });

    for (const child of comp.children ?? []) {
      // Respect position.method: 'top' = offset from fore end, 'bottom' = offset from aft end
      const childMethod = (child.position?.method ?? 'top') as string;
      const offset = parseNum(child.position?.offset, 0);
      let childYTop: number;
      if (childMethod === 'bottom') {
        childYTop = yBottom - offset;
      } else if (childMethod === 'middle') {
        childYTop = (yTop + yBottom) / 2 - offset;
      } else {
        childYTop = yTop - offset;
      }

      if (child.type === 'trapezoidfinset' || child.type === 'freeformfinset') {
        // OR method="bottom" offset=0: root TE sits at parent aft face.
        // childYTop = parentYBottom = root TE position; root LE is rootchord further toward nose.
        const finPts = (child.finpoints as { x: number; y: number }[] | undefined) ?? [];
        const finRootChord = child.type === 'freeformfinset' && finPts.length > 0
          ? Math.max(...finPts.map(p => parseNum(p.x, 0)))
          : parseNum(child.rootchord, 0.15);
        items.push({
          id: child.id, type: child.type, comp: child,
          yBottom: childYTop,                  // root TE = parent aft face
          yTop: childYTop + finRootChord,      // root LE = inside parent tube
          radius: radius + parseNum(child.span, 0.1),
          parentRadius: radius,
        });
      } else if (child.type === 'parachute') {
        const pr = Math.min(radius * 0.65, 0.035);
        items.push({
          id: child.id, type: 'parachute', comp: child,
          yBottom: childYTop - pr,
          yTop: childYTop + pr,
          radius: pr,
          parentRadius: radius,
        });
      } else if (['bulkhead', 'centeringring', 'engineblock'].includes(child.type)) {
        const cLen = Math.max(0.003, parseNum(child.length, 0.003));
        items.push({
          id: child.id, type: child.type, comp: child,
          yBottom: childYTop - cLen,
          yTop: childYTop,
          radius: parseNum(child.outerradius, radius * 0.92),
          parentRadius: radius,
        });
      }

      // Recurse into motor mount children (centering rings, bulkheads, etc.)
      const childLen = parseNum(child.length, 0);
      const childYBottom = childYTop - childLen;
      for (const gc of child.children ?? []) {
        if (!['innertube', 'centeringring', 'bulkhead', 'engineblock'].includes(gc.type)) continue;
        const gcMethod = (gc.position?.method ?? 'top') as string;
        const gcOffset = parseNum(gc.position?.offset, 0);
        let gcYTop: number;
        if (gcMethod === 'bottom') {
          gcYTop = childYBottom - gcOffset;
        } else if (gcMethod === 'middle') {
          gcYTop = (childYTop + childYBottom) / 2 - gcOffset;
        } else {
          gcYTop = childYTop - gcOffset;
        }
        const gcLen = Math.max(0.003, parseNum(gc.length, 0.01));
        items.push({
          id: gc.id, type: gc.type, comp: gc,
          yBottom: gcYTop - gcLen,
          yTop: gcYTop,
          radius: parseNum(gc.outerradius, radius * 0.5),
          parentRadius: radius,
        });
      }
    }

    yTop = yBottom;
  }

  return items;
}

// ── Scene camera reset helper ─────────────────────────────────────────────────
function CameraRig({ centerY, camDist }: { centerY: number; camDist: number }) {
  const { camera, controls } = useThree();
  const camSet = useRef(false);

  // Set camera position once on first render
  useEffect(() => {
    if (camSet.current) return;
    camSet.current = true;
    camera.position.set(camDist * 0.45, centerY + camDist * 0.15, camDist * 0.9);
    camera.lookAt(0, centerY, 0);
  }, [camera, centerY, camDist]);

  // Set orbit target whenever controls become available
  useEffect(() => {
    if (!controls) return;
    (controls as any).target.set(0, centerY, 0);
    (controls as any).update();
  }, [controls, centerY]);

  return null;
}

// ── Mesh sub-components ───────────────────────────────────────────────────────

function NoseconeMesh({ item, sel, onSel }: { item: RenderItem; sel: boolean; onSel: (id: string) => void }) {
  const shape = (item.comp.shape as string) ?? 'ogive';
  const L = Math.max(0.001, item.yTop - item.yBottom);
  const geo = useMemo(
    () => new THREE.LatheGeometry(noseconeProfile(shape, L, item.radius), 32),
    [shape, L, item.radius],
  );
  return (
    <mesh geometry={geo} position={[0, item.yBottom, 0]}
      onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onSel(item.id); }}>
      <meshStandardMaterial color={sel ? C_SEL : C_NOSE} />
    </mesh>
  );
}

function BodyTubeMesh({ item, sel, onSel }: { item: RenderItem; sel: boolean; onSel: (id: string) => void }) {
  const L = Math.max(0.001, item.yTop - item.yBottom);
  const geo = useMemo(
    () => new THREE.CylinderGeometry(item.radius, item.radius, L, 32, 1, false),
    [item.radius, L],
  );
  return (
    <mesh geometry={geo} position={[0, item.yBottom + L / 2, 0]}
      onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onSel(item.id); }}>
      <meshStandardMaterial color={sel ? C_SEL : C_TUBE} />
    </mesh>
  );
}

function TrapFinSetMesh({ item, sel, onSel }: { item: RenderItem; sel: boolean; onSel: (id: string) => void }) {
  const { comp } = item;
  const root = parseNum(comp.rootchord, 0.15);
  const tip = parseNum(comp.tipchord, 0.06);
  const span = parseNum(comp.span, 0.1);
  const sweep = parseNum(comp.sweep, 0);
  const thick = parseNum(comp.thickness, 0.003);
  const N = Math.max(2, Math.min(8, Math.round(parseNum(comp.fincount, 4))));
  const tubeR = item.parentRadius ?? 0.05;

  const geo = useMemo(() => {
    // Group origin = root LE (inside parent tube). Shape extends toward tail (-Y).
    const s = new THREE.Shape();
    s.moveTo(0, 0);               // root LE
    s.lineTo(0, -root);           // root TE
    s.lineTo(span, -sweep - tip); // tip TE
    s.lineTo(span, -sweep);       // tip LE
    s.closePath();
    return new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: false });
  }, [root, tip, span, sweep, thick]);

  return (
    <>
      {Array.from({ length: N }, (_, i) => (
        <group key={i} position={[0, item.yTop, 0]} rotation={[0, (2 * Math.PI * i) / N, 0]}>
          <mesh geometry={geo} position={[tubeR, 0, -thick / 2]}
            onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onSel(item.id); }}>
            <meshStandardMaterial color={sel ? C_SEL : C_FIN} side={THREE.DoubleSide} />
          </mesh>
        </group>
      ))}
    </>
  );
}

function FreeformFinSetMesh({ item, sel, onSel }: { item: RenderItem; sel: boolean; onSel: (id: string) => void }) {
  const { comp } = item;
  const pts = (comp.finpoints as { x: number; y: number }[] | undefined) ?? [];
  const thick = parseNum(comp.thickness, 0.003);
  const N = Math.max(2, Math.min(8, Math.round(parseNum(comp.fincount, 4))));
  const tubeR = item.parentRadius ?? 0.05;

  // Root chord = max x in finpoints (OR: x = aft direction, 0 = root LE, max = root TE)
  const finRoot = pts.length > 0 ? Math.max(...pts.map(p => parseNum(p.x, 0))) : 0.15;

  const geo = useMemo(() => {
    if (pts.length < 3) return null;
    // Group origin = root LE (inside parent tube). Shape extends toward tail (-Y).
    // OR x=aft (0=root LE, max=root TE) → local Y = -x; OR y=span → local X
    const s = new THREE.Shape(pts.map(p => new THREE.Vector2(p.y, -parseNum(p.x, 0))));
    return new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: false });
  }, [pts, thick]);

  if (!geo) return null;
  return (
    <>
      {Array.from({ length: N }, (_, i) => (
        <group key={i} position={[0, item.yTop, 0]} rotation={[0, (2 * Math.PI * i) / N, 0]}>
          <mesh geometry={geo} position={[tubeR, 0, -thick / 2]}
            onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onSel(item.id); }}>
            <meshStandardMaterial color={sel ? C_SEL : C_FIN} side={THREE.DoubleSide} />
          </mesh>
        </group>
      ))}
    </>
  );
}

function InternalMesh({ item, sel, onSel }: { item: RenderItem; sel: boolean; onSel: (id: string) => void }) {
  const L = Math.max(0.001, item.yTop - item.yBottom);
  const R = item.radius;
  const innerR = parseNum(item.comp.innerradius, 0);

  const { geo, rotation, pos } = useMemo<{
    geo: THREE.BufferGeometry;
    rotation: [number, number, number];
    pos: [number, number, number];
  }>(() => {
    if (innerR > 0.001 && innerR < R - 0.001) {
      const shape = new THREE.Shape();
      shape.arc(0, 0, R, 0, Math.PI * 2, false);
      const hole = new THREE.Path();
      hole.arc(0, 0, innerR, 0, Math.PI * 2, true);
      shape.holes.push(hole);
      return {
        geo: new THREE.ExtrudeGeometry(shape, { depth: L, bevelEnabled: false }),
        rotation: [-Math.PI / 2, 0, 0],
        pos: [0, item.yBottom, 0],
      };
    }
    return {
      geo: new THREE.CylinderGeometry(R, R, L, 24),
      rotation: [0, 0, 0],
      pos: [0, item.yBottom + L / 2, 0],
    };
  }, [R, innerR, L, item.yBottom]);

  return (
    <mesh geometry={geo} position={pos} rotation={rotation}
      onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onSel(item.id); }}>
      <meshStandardMaterial color={sel ? C_SEL : C_INTERNAL} transparent opacity={0.65} />
    </mesh>
  );
}

function ParachuteMesh({ item, sel, onSel }: { item: RenderItem; sel: boolean; onSel: (id: string) => void }) {
  const R = item.radius;
  const geo = useMemo(() => new THREE.SphereGeometry(R, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), [R]);
  const yMid = (item.yTop + item.yBottom) / 2;
  return (
    <mesh geometry={geo} position={[0, yMid, 0]}
      onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onSel(item.id); }}>
      <meshStandardMaterial color={sel ? C_SEL : C_CHUTE} transparent opacity={0.55} />
    </mesh>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────
export function Rocket3DView({
  tree,
  selectedId,
  onSelect,
}: {
  tree: OrkTree;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const items = useMemo(() => buildRenderList(tree), [tree]);
  const totalLen = useMemo(() => items.reduce((m, it) => Math.max(m, it.yTop), 0.1), [items]);
  const maxR = useMemo(() => items.filter(it => ['nosecone', 'bodytube', 'tubecoupler'].includes(it.type))
    .reduce((m, it) => Math.max(m, it.radius), 0.05), [items]);
  const centerY = totalLen / 2;
  const camDist = Math.max(totalLen * 1.6, maxR * 8, 0.4);

  return (
    <Canvas style={{ background: '#111827', width: '100%', height: '100%' }}>
      <CameraRig centerY={centerY} camDist={camDist} />
      <ambientLight intensity={0.5} />
      <directionalLight position={[5, 10, 7]} intensity={0.8} />
      <directionalLight position={[-4, 5, -6]} intensity={0.3} />
      <TrackballControls makeDefault />
      <Suspense fallback={null}>
        {items.map(item => {
          const sel = item.id === selectedId;
          if (item.type === 'nosecone')
            return <NoseconeMesh key={item.id} item={item} sel={sel} onSel={onSelect} />;
          if (item.type === 'bodytube' || item.type === 'tubecoupler')
            return <BodyTubeMesh key={item.id} item={item} sel={sel} onSel={onSelect} />;
          if (item.type === 'trapezoidfinset')
            return <TrapFinSetMesh key={item.id} item={item} sel={sel} onSel={onSelect} />;
          if (item.type === 'freeformfinset')
            return <FreeformFinSetMesh key={item.id} item={item} sel={sel} onSel={onSelect} />;
          if (['bulkhead', 'centeringring', 'engineblock', 'innertube'].includes(item.type))
            return <InternalMesh key={item.id} item={item} sel={sel} onSel={onSelect} />;
          if (item.type === 'parachute')
            return <ParachuteMesh key={item.id} item={item} sel={sel} onSel={onSelect} />;
          return null;
        })}
      </Suspense>
    </Canvas>
  );
}
