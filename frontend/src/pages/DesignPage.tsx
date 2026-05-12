import { useState, useRef, useEffect, useCallback } from 'react';

// ── Chat mode types (existing) ──────────────────────────────────────────────

interface DesignConfig {
  altitudeTargetFt: number;
  recovery: 'dual' | 'single';
  mainDeployFt: number;
  drogueEvent: 'apogee' | 'apogee+1s';
}

interface DesignState {
  tube_od_in: number | null;
  fwd_bay_length_in: number | null;
  avionics_bay_length_in: number | null;
  wall_in: number | null;
  nose_shape: string | null;
  fin_count: number | null;
  fin_root_in: number | null;
  fin_span_in: number | null;
  fin_thickness_in: number | null;
  tube_material: string | null;
  fin_material: string | null;
  motor_designation: string | null;
  est_margin_cal: number | null;
  flutter_safety_factor: number | null;
  dry_mass_lb: number | null;
  wet_mass_lb: number | null;
  total_length_in: number | null;
  est_altitude_ft: number | null;
}

interface MotorOption {
  designation: string;
  manufacturer: string;
  impulse_class: string;
  predicted_altitude_ft: number | null;
  margin_cal: number | null;
  flutter_sf: number | null;
  twr: number | null;
  fin_span_in: number | null;
  fin_thickness_in: number | null;
  motor_od_in: number | null;
  total_impulse_ns: number | null;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

// ── Editor mode types (new) ─────────────────────────────────────────────────

interface OrkMaterial {
  name: string;
  type: string;
  density: number;
}

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
  comment?: string | null;
  position?: OrkPosition;
  material?: OrkMaterial | null;
  overridemass?: number;
  overridesubcomponentsmass?: boolean;
  finish?: string;
  color?: { red?: string; green?: string; blue?: string; alpha?: string };
  children?: OrkComponent[];
  [key: string]: unknown; // dynamic type-specific props
}

interface OrkTree {
  rocket_name: string;
  designer: string;
  version: string;
  creator: string;
  components: OrkComponent[];
}

// ── Shared ──────────────────────────────────────────────────────────────────

interface DesignPageProps {
  setSelectedFile?: (f: File | null) => void;
  setActivePage?: (page: string) => void;
}

const EMPTY_DESIGN: DesignState = {
  tube_od_in: null, fwd_bay_length_in: null, avionics_bay_length_in: null,
  wall_in: null, nose_shape: null, fin_count: null, fin_root_in: null,
  fin_span_in: null, fin_thickness_in: null, tube_material: null, fin_material: null,
  motor_designation: null, est_margin_cal: null, flutter_safety_factor: null,
  dry_mass_lb: null, wet_mass_lb: null, total_length_in: null, est_altitude_ft: null,
};

const M_TO_MM = 1000;

// ── Component type metadata ─────────────────────────────────────────────────

const TYPE_ICON: Record<string, string> = {
  nosecone: '🔶', bodytube: '▮', tubecoupler: '◯', innertube: '▯',
  trapezoidfinset: '△', freeformfinset: '△', parachute: '🪂',
  shockcord: '〰', masscomponent: '●', bulkhead: '▬',
  centeringring: '◎', engineblock: '▬', railbutton: '📍',
  motormount: '⚙', stage: '🚀',
};

const TYPE_LABEL: Record<string, string> = {
  nosecone: 'Nose Cone', bodytube: 'Body Tube', tubecoupler: 'Tube Coupler',
  innertube: 'Inner Tube', trapezoidfinset: 'Trapezoid Fins',
  freeformfinset: 'Freeform Fins', parachute: 'Parachute', shockcord: 'Shock Cord',
  masscomponent: 'Mass Component', bulkhead: 'Bulkhead',
  centeringring: 'Centering Ring', engineblock: 'Engine Block',
  railbutton: 'Rail Button', motormount: 'Motor Mount', stage: 'Stage',
};

// Number fields per component type (internal name → display label + unit)
const TYPE_FIELDS: Record<string, { key: string; label: string; unit: string; step?: number }[]> = {
  nosecone: [
    { key: 'length', label: 'Length', unit: 'mm', step: 0.1 },
    { key: 'thickness', label: 'Wall', unit: 'mm', step: 0.01 },
    { key: 'aftradius', label: 'Aft Radius', unit: 'mm', step: 0.01 },
    { key: 'aftshoulderradius', label: 'Shoulder Radius', unit: 'mm', step: 0.01 },
    { key: 'aftshoulderlength', label: 'Shoulder Length', unit: 'mm', step: 0.1 },
    { key: 'aftshoulderthickness', label: 'Shoulder Wall', unit: 'mm', step: 0.01 },
    { key: 'shapeparameter', label: 'Shape Param', unit: '', step: 0.01 },
  ],
  bodytube: [
    { key: 'length', label: 'Length', unit: 'mm', step: 0.1 },
    { key: 'radius', label: 'Radius', unit: 'mm', step: 0.01 },
    { key: 'thickness', label: 'Wall', unit: 'mm', step: 0.01 },
  ],
  tubecoupler: [
    { key: 'length', label: 'Length', unit: 'mm', step: 0.1 },
    { key: 'outerradius', label: 'Outer Radius', unit: 'mm', step: 0.01 },
  ],
  innertube: [
    { key: 'length', label: 'Length', unit: 'mm', step: 0.1 },
    { key: 'outerradius', label: 'Outer Radius', unit: 'mm', step: 0.01 },
    { key: 'thickness', label: 'Wall', unit: 'mm', step: 0.01 },
  ],
  trapezoidfinset: [
    { key: 'fincount', label: 'Count', unit: '', step: 1 },
    { key: 'rootchord', label: 'Root Chord', unit: 'mm', step: 0.1 },
    { key: 'tipchord', label: 'Tip Chord', unit: 'mm', step: 0.1 },
    { key: 'span', label: 'Span', unit: 'mm', step: 0.1 },
    { key: 'sweep', label: 'Sweep', unit: 'mm', step: 0.1 },
    { key: 'thickness', label: 'Thickness', unit: 'mm', step: 0.01 },
    { key: 'cant', label: 'Cant', unit: '°', step: 0.1 },
  ],
  freeformfinset: [
    { key: 'fincount', label: 'Count', unit: '', step: 1 },
    { key: 'thickness', label: 'Thickness', unit: 'mm', step: 0.01 },
    { key: 'cant', label: 'Cant', unit: '°', step: 0.1 },
  ],
  parachute: [
    { key: 'diameter', label: 'Diameter', unit: 'mm', step: 1 },
    { key: 'cd', label: 'Cd', unit: '', step: 0.01 },
    { key: 'deployaltitude', label: 'Deploy Alt', unit: 'm', step: 1 },
    { key: 'linecount', label: 'Lines', unit: '', step: 1 },
    { key: 'linelength', label: 'Line Length', unit: 'mm', step: 1 },
  ],
  shockcord: [
    { key: 'cordlength', label: 'Length', unit: 'mm', step: 1 },
  ],
  masscomponent: [
    { key: 'mass', label: 'Mass', unit: 'g', step: 0.1 },
    { key: 'packedlength', label: 'Packed Length', unit: 'mm', step: 0.1 },
    { key: 'packedradius', label: 'Packed Radius', unit: 'mm', step: 0.01 },
  ],
  bulkhead: [
    { key: 'length', label: 'Thickness', unit: 'mm', step: 0.1 },
    { key: 'outerradius', label: 'Outer Radius', unit: 'mm', step: 0.01 },
  ],
  centeringring: [
    { key: 'length', label: 'Thickness', unit: 'mm', step: 0.1 },
    { key: 'outerradius', label: 'Outer Radius', unit: 'mm', step: 0.01 },
    { key: 'innerradius', label: 'Inner Radius', unit: 'mm', step: 0.01 },
  ],
  engineblock: [
    { key: 'length', label: 'Thickness', unit: 'mm', step: 0.1 },
    { key: 'outerradius', label: 'Outer Radius', unit: 'mm', step: 0.01 },
    { key: 'innerradius', label: 'Inner Radius', unit: 'mm', step: 0.01 },
  ],
  railbutton: [
    { key: 'outerdiameter', label: 'Outer Dia', unit: 'mm', step: 0.1 },
    { key: 'innerdiameter', label: 'Inner Dia', unit: 'mm', step: 0.1 },
    { key: 'height', label: 'Height', unit: 'mm', step: 0.1 },
  ],
};

// Convert internal meters value to display unit
function toDisplay(val: unknown, unit: string): string {
  if (val == null || val === '') return '';
  const n = typeof val === 'string' ? parseFloat(val) : (val as number);
  if (isNaN(n)) return '';
  if (unit === 'mm') return (n * M_TO_MM).toPrecision(6).replace(/\.?0+$/, '');
  if (unit === 'g') return (n * 1000).toPrecision(6).replace(/\.?0+$/, '');
  if (unit === '°') return n.toFixed(1);
  if (unit === '') return String(Math.round(n));
  return n.toPrecision(6).replace(/\.?0+$/, '');
}

// Convert display value back to meters (internal)
function fromDisplay(s: string, unit: string): number | null {
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  if (unit === 'mm') return n / M_TO_MM;
  if (unit === 'g') return n / 1000;
  return n;
}

// ── Chat mode sub-component ────────────────────────────────────────────────

function StateRow({
  label, value, unit, color,
}: { label: string; value: string | number | null; unit?: string; color?: string }) {
  const populated = value !== null && value !== undefined;
  return (
    <div className="flex justify-between text-xs">
      <span className="text-gray-500">{label}</span>
      <span className={populated ? (color ?? 'text-gray-200') : 'text-gray-700'}>
        {populated ? `${value}${unit ?? ''}` : '—'}
      </span>
    </div>
  );
}

function ChatDesign({
  setSelectedFile: _setSelectedFile, setActivePage: _setActivePage,
}: DesignPageProps) {
  const [config, setConfig] = useState<DesignConfig>({
    altitudeTargetFt: 15000,
    recovery: 'dual',
    mainDeployFt: 700,
    drogueEvent: 'apogee',
  });
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [design, setDesign] = useState<DesignState>(EMPTY_DESIGN);
  const [orkB64, setOrkB64] = useState<string | null>(null);
  const [motorOptions, setMotorOptions] = useState<MotorOption[]>([]);
  const [constraints, setConstraints] = useState<Record<string, unknown>>({});
  const [resolvedConstraints, setResolvedConstraints] = useState<Record<string, unknown>>({});
  const [selectedMotor, setSelectedMotor] = useState<string | null>(null);
  const [selectingMotor, setSelectingMotor] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, motorOptions]);

  const apiConfig = () => ({
    altitude_target_ft: config.altitudeTargetFt,
    recovery: config.recovery,
    main_deploy_ft: config.mainDeployFt,
    drogue_deploy: config.drogueEvent === 'apogee+1s' ? 'apogee' : 'apogee',
  });

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;
    const newMessages: Message[] = [...messages, { role: 'user', content: text }];
    setMessages(newMessages);
    setInput('');
    setLoading(true);
    setError(null);

    try {
      const resp = await fetch('/api/design/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newMessages,
          config: apiConfig(),
          base_constraints: resolvedConstraints,
        }),
      });

      if (!resp.ok) {
        const body = await resp.json().catch(() => ({ detail: resp.statusText }));
        throw new Error(body.detail ?? resp.statusText);
      }

      const data = await resp.json();
      setMessages(prev => [...prev, { role: 'assistant', content: data.message }]);
      if (data.design_state) setDesign(data.design_state);
      if (data.ork_b64) setOrkB64(data.ork_b64);
      if (data.resolved_constraints) {
        setResolvedConstraints(data.resolved_constraints);
        setConstraints(data.resolved_constraints);
      }
      if (data.motor_options?.length) {
        setMotorOptions(data.motor_options);
        setSelectedMotor(data.motor_options[0]?.designation ?? null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const selectMotor = async (designation: string) => {
    if (selectingMotor) return;
    setSelectingMotor(designation);
    setError(null);
    try {
      const resp = await fetch('/api/design/select-motor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          designation,
          motor_options: motorOptions,
          constraints,
          config: apiConfig(),
        }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({ detail: resp.statusText }));
        throw new Error(body.detail ?? resp.statusText);
      }
      const data = await resp.json();
      if (data.design_state) setDesign(data.design_state);
      if (data.ork_b64) setOrkB64(data.ork_b64);
      setSelectedMotor(designation);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSelectingMotor(null);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const hasDesign = Object.values(design).some(v => v !== null);

  const sfColor = (sf: number | null) =>
    sf === null ? undefined : sf >= 1.2 ? 'text-green-400' : sf >= 1.0 ? 'text-yellow-400' : 'text-red-400';

  const altColor = (alt: number | null) => {
    if (!alt) return undefined;
    const diff = Math.abs(alt - config.altitudeTargetFt) / config.altitudeTargetFt;
    return diff <= 0.10 ? 'text-green-400' : diff <= 0.25 ? 'text-yellow-400' : 'text-gray-400';
  };

  return (
    <div className="flex h-[calc(100vh-57px)]">
      {/* Sidebar */}
      <aside className="w-64 shrink-0 border-r border-gray-800 flex flex-col p-4 gap-4 overflow-y-auto">
        <div className="space-y-3">
          <p className="text-[10px] text-gray-500 uppercase tracking-wide font-semibold">Flight Config</p>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-400">Target Altitude (ft)</span>
            <input type="number" step="500" min="1000" max="50000"
              value={config.altitudeTargetFt}
              onChange={e => setConfig(c => ({ ...c, altitudeTargetFt: Number(e.target.value) }))}
              className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-1 text-xs text-white" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-400">Recovery</span>
            <select value={config.recovery}
              onChange={e => setConfig(c => ({ ...c, recovery: e.target.value as 'dual' | 'single' }))}
              className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-1 text-xs text-white">
              <option value="dual">Dual Deploy</option>
              <option value="single">Single Deploy</option>
            </select>
          </label>
          {config.recovery === 'dual' && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-400">Main Deploy (ft AGL)</span>
              <input type="number" step="50" min="200" max="2000"
                value={config.mainDeployFt}
                onChange={e => setConfig(c => ({ ...c, mainDeployFt: Number(e.target.value) }))}
                className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-1 text-xs text-white" />
            </label>
          )}
        </div>
        <div className="space-y-2">
          <p className="text-[10px] text-gray-500 uppercase tracking-wide font-semibold">Design State</p>
          <div className="space-y-1">
            <StateRow label="Motor" value={design.motor_designation} />
            <StateRow label="Tube OD" value={design.tube_od_in} unit='"' />
            <StateRow label="Wall" value={design.wall_in} unit='"' />
            <StateRow label="Nose shape" value={design.nose_shape} />
            <StateRow label="Fwd section" value={design.fwd_bay_length_in} unit='"' />
            <StateRow label="Avionics bay" value={design.avionics_bay_length_in} unit='"' />
            <StateRow label="Fin count" value={design.fin_count} />
            <StateRow label="Fin root" value={design.fin_root_in} unit='"' />
            <StateRow label="Fin span" value={design.fin_span_in} unit='"' />
            <StateRow label="Fin thickness" value={design.fin_thickness_in} unit='"' />
            <StateRow label="Tube material" value={design.tube_material} />
            <StateRow label="Fin material" value={design.fin_material} />
            <StateRow label="Dry weight" value={design.dry_mass_lb} unit=" lb" />
            <StateRow label="Wet weight" value={design.wet_mass_lb} unit=" lb" />
            <StateRow label="Total length" value={design.total_length_in} unit='"' />
            <StateRow label="Est. margin" value={design.est_margin_cal} unit=" cal" />
            <StateRow label="Flutter SF" value={design.flutter_safety_factor}
              color={sfColor(design.flutter_safety_factor)} />
            <StateRow label="Est. altitude" value={design.est_altitude_ft} unit=" ft" />
          </div>
        </div>
        {hasDesign && orkB64 && (
          <div className="space-y-2 pt-2 border-t border-gray-800">
            <p className="text-[10px] text-gray-500 uppercase tracking-wide font-semibold">Actions</p>
            <button onClick={() => {
              const bytes = atob(orkB64);
              const arr = new Uint8Array(bytes.length);
              for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
              const blob = new Blob([arr], { type: 'application/octet-stream' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url; a.download = 'rocketbridge_design.ork'; a.click();
              URL.revokeObjectURL(url);
            }} className="w-full bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold px-3 py-2 rounded-lg transition-colors">
              Download .ork
            </button>
            <p className="text-[10px] text-gray-600 leading-relaxed">
              Open in OpenRocket → run simulation → re-upload to the Simulate tab.
            </p>
          </div>
        )}
      </aside>

      {/* Chat panel */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {messages.length === 0 && (
            <div className="flex items-center justify-center h-full text-gray-700 text-sm text-center px-8">
              Describe your rocket — diameter, motor preference, altitude goal — and I'll rank matching motors and generate a ready-to-fly .ork file.
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-xl px-4 py-2.5 text-sm ${
                m.role === 'user'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-900 border border-gray-800 text-gray-200 font-mono text-xs whitespace-pre-wrap'
              }`}>{m.content}</div>
            </div>
          ))}
          {motorOptions.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] text-gray-500 uppercase tracking-wide font-semibold px-1">Motor Options</p>
              {motorOptions.slice(0, 10).map((opt) => {
                const isSelected = opt.designation === selectedMotor;
                const isLoading = opt.designation === selectingMotor;
                return (
                  <div key={opt.designation}
                    className={`rounded-xl border px-4 py-3 flex items-center justify-between gap-3 transition-colors ${
                      isSelected ? 'border-blue-500 bg-blue-950/40' : 'border-gray-800 bg-gray-900/60 hover:border-gray-700'
                    }`}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-white">{opt.designation}</span>
                        <span className="text-xs text-gray-500">{opt.manufacturer}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">
                          {opt.impulse_class}-class
                        </span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
                        <span className={altColor(opt.predicted_altitude_ft) ?? 'text-gray-400'}>
                          {opt.predicted_altitude_ft != null ? `~${opt.predicted_altitude_ft.toLocaleString()} ft` : '? ft'}
                        </span>
                        <span className="text-gray-500">margin {opt.margin_cal ?? '?'} cal</span>
                        <span className={sfColor(opt.flutter_sf) ?? 'text-gray-500'}>
                          flutter {opt.flutter_sf ?? '?'}×
                        </span>
                        <span className="text-gray-500">TWR {opt.twr ?? '?'}</span>
                        <span className="text-gray-600">
                          {opt.fin_span_in}" span · {opt.fin_thickness_in}" thick
                        </span>
                      </div>
                    </div>
                    <button onClick={() => selectMotor(opt.designation)}
                      disabled={isSelected || !!selectingMotor}
                      className={`shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors ${
                        isSelected ? 'bg-blue-600 text-white cursor-default'
                          : 'bg-gray-800 hover:bg-gray-700 text-gray-300 disabled:opacity-40'
                      }`}>
                      {isLoading ? '…' : isSelected ? 'Selected' : 'Select'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {loading && (
            <div className="flex justify-start">
              <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-2.5 flex items-center gap-2">
                <div className="w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                <span className="text-gray-500 text-xs">Analyzing…</span>
              </div>
            </div>
          )}
          {error && (
            <div className="bg-red-950 border border-red-800 rounded-xl px-4 py-2.5 text-xs text-red-300">{error}</div>
          )}
          <div ref={bottomRef} />
        </div>
        <div className="border-t border-gray-800 px-4 py-3 flex gap-2">
          <textarea value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown} disabled={loading} rows={2}
            placeholder="Describe your rocket — diameter, min-diameter, fin material, altitude goal…"
            className="flex-1 bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 resize-none focus:outline-none focus:border-blue-600 disabled:opacity-50" />
          <button onClick={send} disabled={!input.trim() || loading}
            className="self-end bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors">
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Editor mode sub-component ──────────────────────────────────────────────

function findComponent(tree: OrkTree, id: string): OrkComponent | null {
  function walk(comps: OrkComponent[]): OrkComponent | null {
    for (const c of comps) {
      if (c.id === id) return c;
      const found = walk(c.children ?? []);
      if (found) return found;
    }
    return null;
  }
  return walk(tree.components);
}

function updateComponent(tree: OrkTree, id: string, updates: Partial<OrkComponent>): OrkTree {
  function walk(comps: OrkComponent[]): OrkComponent[] {
    return comps.map(c => {
      if (c.id === id) return { ...c, ...updates };
      if (c.children) return { ...c, children: walk(c.children) };
      return c;
    });
  }
  return { ...tree, components: walk(tree.components) };
}

// Component tree sidebar
function ComponentTree({
  components, selectedId, onSelect, depth,
}: { components: OrkComponent[]; selectedId: string | null; onSelect: (id: string) => void; depth: number }) {
  return (
    <>
      {components.map(comp => (
        <div key={comp.id}>
          <button onClick={() => onSelect(comp.id)}
            className={`w-full text-left px-2 py-1 rounded text-xs flex items-center gap-1.5 transition-colors ${
              comp.id === selectedId ? 'bg-blue-600/30 text-blue-300 border border-blue-500/50'
                : 'text-gray-400 hover:bg-gray-800 border border-transparent'
            }`}
            style={{ paddingLeft: `${depth * 12 + 8}px` }}>
            <span>{TYPE_ICON[comp.type] ?? '·'}</span>
            <span className="truncate">{comp.name}</span>
          </button>
          {comp.children && comp.children.length > 0 && (
            <ComponentTree components={comp.children} selectedId={selectedId} onSelect={onSelect} depth={depth + 1} />
          )}
        </div>
      ))}
    </>
  );
}

// 2D rocket profile canvas
function RocketCanvas({ tree, selectedId }: { tree: OrkTree; selectedId: string | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !tree.components.length) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);

    const PAD = 30;
    const W = rect.width - 2 * PAD;
    const H = rect.height - 2 * PAD;

    // Collect all body tubes and nosecone to compute total length and max radius
    let totalLength = 0;
    let maxRadius = 0;
    const stageComps = tree.components[0]?.children ?? [];

    // Compute cumulative positions
    const positions: { comp: OrkComponent; x: number; length: number; radius: number; selected: boolean }[] = [];
    let cumX = 0;

    for (const comp of stageComps) {
      const len = (comp.length as number) ?? 0;
      const rad = (comp.radius as number) ?? (comp.aftradius as number) ?? (comp.outerradius as number) ?? 0;
      if (comp.type === 'nosecone' || comp.type === 'bodytube' || comp.type === 'tubecoupler') {
        if (len > 0) totalLength += len;
        if (rad > maxRadius) maxRadius = rad;
        positions.push({ comp, x: cumX, length: len, radius: rad, selected: comp.id === selectedId });
        if (comp.type === 'nosecone') cumX += len;
        else cumX += len;
      }
    }

    if (totalLength === 0 || maxRadius === 0) return;

    const scaleX = W / totalLength;
    const bodyH = Math.min(H * 0.5, maxRadius * scaleX * 2);
    const scaleY = bodyH / (2 * maxRadius);
    const centerY = rect.height / 2;

    // Draw each component
    for (const p of positions) {
      const x = PAD + p.x * scaleX;
      const y1 = centerY - p.radius * scaleY;
      const y2 = centerY + p.radius * scaleY;
      const w = p.length * scaleX;

      ctx.fillStyle = p.selected ? '#3b82f6' : '#6b7280';
      ctx.strokeStyle = p.selected ? '#60a5fa' : '#9ca3af';
      ctx.lineWidth = p.selected ? 2 : 1;

      if (p.comp.type === 'nosecone') {
        const shape = (p.comp.shape as string) ?? 'conical';
        ctx.beginPath();
        if (shape === 'conical') {
          ctx.moveTo(x, centerY - p.radius * scaleY);
          ctx.lineTo(x + w, y1);
          ctx.lineTo(x + w, y2);
          ctx.lineTo(x, centerY + p.radius * scaleY);
        } else if (shape === 'haack' || shape === 'ogive' || shape === 'vonkarman') {
          // Approximate with quadratic curve
          ctx.moveTo(x, centerY);
          ctx.quadraticCurveTo(x + w * 0.15, y1, x + w, y1);
          ctx.lineTo(x + w, y2);
          ctx.quadraticCurveTo(x + w * 0.15, y2, x, centerY);
        } else {
          // elliptical/parabolic — default arc
          ctx.moveTo(x, centerY);
          ctx.quadraticCurveTo(x + w * 0.3, y1, x + w, y1);
          ctx.lineTo(x + w, y2);
          ctx.quadraticCurveTo(x + w * 0.3, y2, x, centerY);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.fillRect(x, y1, w, y2 - y1);
        ctx.strokeRect(x, y1, w, y2 - y1);
      }
    }

    // Draw fins
    for (const comp of stageComps) {
      if (comp.type === 'trapezoidfinset' || comp.type === 'freeformfinset') {
        const selected = comp.id === selectedId;
        ctx.fillStyle = selected ? '#3b82f680' : '#6b728080';
        ctx.strokeStyle = selected ? '#60a5fa' : '#9ca3af';
        ctx.lineWidth = selected ? 2 : 1;

        const pos = comp.position;
        const finX = PAD + ((pos?.offset ?? 0) + (pos?.position_value ?? 0)) * scaleX;
        const rootChord = ((comp.rootchord as number) ?? (comp.sweep as number) ?? 0.1) * scaleX;
        const span = ((comp.span as number) ?? 0.05) * scaleY;
        const tipChord = ((comp.tipchord as number) ?? rootChord * 0.4) * scaleX;

        // Bottom fin
        const bodyEdge = centerY + maxRadius * scaleY;
        ctx.beginPath();
        ctx.moveTo(finX, bodyEdge);
        ctx.lineTo(finX + rootChord, bodyEdge);
        ctx.lineTo(finX + rootChord - (rootChord - tipChord) / 2, bodyEdge + span);
        ctx.lineTo(finX + (rootChord - tipChord) / 2, bodyEdge + span);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Top fin (mirror)
        const bodyEdgeTop = centerY - maxRadius * scaleY;
        ctx.beginPath();
        ctx.moveTo(finX, bodyEdgeTop);
        ctx.lineTo(finX + rootChord, bodyEdgeTop);
        ctx.lineTo(finX + rootChord - (rootChord - tipChord) / 2, bodyEdgeTop - span);
        ctx.lineTo(finX + (rootChord - tipChord) / 2, bodyEdgeTop - span);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }

    // Draw parachutes as small circles
    for (const comp of stageComps) {
      if (comp.type === 'parachute') {
        // Find parent body tube position
        const selected = comp.id === selectedId;
        const pos = comp.position;
        const chuteX = PAD + ((pos?.offset ?? 0) * scaleX);
        const bodyEdge = centerY - maxRadius * scaleY;
        ctx.fillStyle = selected ? '#10b98140' : '#6b728040';
        ctx.strokeStyle = selected ? '#34d399' : '#9ca3af';
        ctx.beginPath();
        ctx.arc(chuteX, bodyEdge, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }, [tree, selectedId]);

  useEffect(() => { draw(); }, [draw]);
  useEffect(() => {
    const handleResize = () => draw();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [draw]);

  if (!tree.components.length) return null;
  return <canvas ref={canvasRef} className="w-full h-48 border-b border-gray-800" />;
}

// Property editor for a selected component
function PropertyEditor({
  comp, onChange,
}: { comp: OrkComponent; onChange: (updates: Partial<OrkComponent>) => void }) {
  const fields = TYPE_FIELDS[comp.type] ?? [];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2 pb-2 border-b border-gray-800">
        <span className="text-lg">{TYPE_ICON[comp.type] ?? '·'}</span>
        <div>
          <div className="text-xs text-gray-500">{TYPE_LABEL[comp.type] ?? comp.type}</div>
          <input type="text" value={comp.name}
            onChange={e => onChange({ name: e.target.value })}
            className="bg-transparent text-sm text-white font-semibold border-b border-gray-700 focus:border-blue-500 outline-none w-full" />
        </div>
      </div>

      {/* Dimensions */}
      {fields.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] text-gray-500 uppercase tracking-wide font-semibold">Dimensions</p>
          {fields.map(f => {
            const val = comp[f.key];
            return (
              <label key={f.key} className="flex items-center gap-2">
                <span className="text-xs text-gray-400 w-24 shrink-0">{f.label}</span>
                <input type="number" step={f.step ?? 0.01}
                  value={toDisplay(val, f.unit)}
                  onChange={e => {
                    const mVal = fromDisplay(e.target.value, f.unit);
                    if (mVal !== null) onChange({ [f.key]: mVal });
                  }}
                  className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white focus:border-blue-500 outline-none" />
                <span className="text-[10px] text-gray-600 w-8">{f.unit}</span>
              </label>
            );
          })}
        </div>
      )}

      {/* Shape (nosecone) */}
      {comp.type === 'nosecone' && (
        <div className="space-y-2">
          <p className="text-[10px] text-gray-500 uppercase tracking-wide font-semibold">Shape</p>
          <select value={(comp.shape as string) ?? 'conical'}
            onChange={e => onChange({ shape: e.target.value })}
            className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white">
            <option value="conical">Conical</option>
            <option value="ogive">Ogive</option>
            <option value="haack">Von Kármán (Haack)</option>
            <option value="elliptical">Elliptical</option>
            <option value="parabolic">Parabolic</option>
          </select>
        </div>
      )}

      {/* Deploy event (parachute) */}
      {comp.type === 'parachute' && (
        <div className="space-y-2">
          <p className="text-[10px] text-gray-500 uppercase tracking-wide font-semibold">Deploy</p>
          <select value={(comp.deployevent as string) ?? 'apogee'}
            onChange={e => onChange({ deployevent: e.target.value })}
            className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white">
            <option value="apogee">Apogee</option>
            <option value="altitude">Altitude</option>
            <option value="ejection_charge">Ejection Charge</option>
          </select>
        </div>
      )}

      {/* Material */}
      {comp.material && (
        <div className="space-y-2">
          <p className="text-[10px] text-gray-500 uppercase tracking-wide font-semibold">Material</p>
          <div className="bg-gray-900/50 border border-gray-800 rounded px-2 py-1.5 space-y-0.5">
            <div className="text-xs text-gray-200">{comp.material.name}</div>
            <div className="text-[10px] text-gray-500">
              {comp.material.type} · {comp.material.density.toFixed(1)} kg/m³
            </div>
          </div>
        </div>
      )}

      {/* Mass override */}
      <div className="space-y-2">
        <p className="text-[10px] text-gray-500 uppercase tracking-wide font-semibold">Mass Override</p>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={!!comp.overridemass}
            onChange={e => onChange({ overridemass: e.target.checked ? 0.1 : 0 })}
            className="rounded border-gray-700 bg-gray-900" />
          <span className="text-xs text-gray-400">Override</span>
        </label>
        {comp.overridemass != null && comp.overridemass !== 0 && (
          <label className="flex items-center gap-2">
            <span className="text-xs text-gray-400 w-24">Mass</span>
            <input type="number" step={0.1}
              value={(comp.overridemass as number * 1000).toFixed(1)}
              onChange={e => {
                const g = parseFloat(e.target.value);
                if (!isNaN(g)) onChange({ overridemass: g / 1000 });
              }}
              className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white" />
            <span className="text-[10px] text-gray-600 w-8">g</span>
          </label>
        )}
      </div>

      {/* Position */}
      {comp.position && (
        <div className="space-y-2">
          <p className="text-[10px] text-gray-500 uppercase tracking-wide font-semibold">Position</p>
          <div className="flex gap-2">
            <select value={comp.position.method}
              onChange={e => onChange({
                position: { ...comp.position!, method: e.target.value, position_type: e.target.value }
              })}
              className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white">
              <option value="top">From Top</option>
              <option value="bottom">From Bottom</option>
              <option value="middle">From Middle</option>
              <option value="absolute">Absolute</option>
            </select>
            <input type="number" step={0.001}
              value={(comp.position.offset * M_TO_MM).toFixed(1)}
              onChange={e => {
                const mm = parseFloat(e.target.value);
                if (!isNaN(mm)) onChange({
                  position: {
                    ...comp.position!,
                    offset: mm / M_TO_MM,
                    position_value: mm / M_TO_MM,
                  }
                });
              }}
              className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white" />
            <span className="text-[10px] text-gray-600 self-center">mm</span>
          </div>
        </div>
      )}

      {/* Comment */}
      <div className="space-y-2">
        <p className="text-[10px] text-gray-500 uppercase tracking-wide font-semibold">Notes</p>
        <textarea value={comp.comment ?? ''}
          onChange={e => onChange({ comment: e.target.value })}
          rows={2}
          className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-white resize-none"
          placeholder="Component notes…" />
      </div>
    </div>
  );
}

function EditorDesign({ setSelectedFile, setActivePage }: DesignPageProps) {
  const [orkTree, setOrkTree] = useState<OrkTree | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [originalOrkB64, setOriginalOrkB64] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadFile = async (file: File) => {
    setError(null);
    try {
      // Store original as base64 for write-back
      const buf = await file.arrayBuffer();
      const b64 = btoa(new Uint8Array(buf).reduce((s, b) => s + String.fromCharCode(b), ''));
      setOriginalOrkB64(b64);

      // Parse component tree
      const form = new FormData();
      form.append('file', file);
      const resp = await fetch('/api/design/parse-ork', { method: 'POST', body: form });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({ detail: resp.statusText }));
        throw new Error(body.detail ?? resp.statusText);
      }
      const tree: OrkTree = await resp.json();
      setOrkTree(tree);
      setSelectedId(tree.components[0]?.children?.[0]?.id ?? null);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) loadFile(f);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f && f.name.endsWith('.ork')) loadFile(f);
  };

  const save = async () => {
    if (!orkTree || !originalOrkB64) return;
    setSaving(true);
    setError(null);
    try {
      const resp = await fetch('/api/design/write-ork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tree: orkTree, ork_b64: originalOrkB64 }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({ detail: resp.statusText }));
        throw new Error(body.detail ?? resp.statusText);
      }
      const data = await resp.json();
      const newB64: string = data.ork_b64;

      // Update stored original for next edit
      setOriginalOrkB64(newB64);
      setDirty(false);

      // Download
      const bytes = atob(newB64);
      const arr = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
      const blob = new Blob([arr], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = (orkTree.rocket_name ?? 'rocket') + '_edited.ork';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const simulate = async () => {
    if (!orkTree || !originalOrkB64) return;
    // If dirty, save first
    let b64 = originalOrkB64;
    if (dirty) {
      setSaving(true);
      try {
        const resp = await fetch('/api/design/write-ork', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tree: orkTree, ork_b64: originalOrkB64 }),
        });
        if (!resp.ok) throw new Error('Save failed');
        const data = await resp.json();
        b64 = data.ork_b64;
        setOriginalOrkB64(b64);
        setDirty(false);
      } catch {
        setSaving(false);
        return;
      }
      setSaving(false);
    }
    const bytes = atob(b64);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    const file = new File([arr], (orkTree.rocket_name ?? 'rocket') + '_edited.ork',
      { type: 'application/octet-stream' });
    setSelectedFile?.(file);
    setActivePage?.('main');
  };

  const selectedComp = orkTree && selectedId ? findComponent(orkTree, selectedId) : null;

  const handleChange = (updates: Partial<OrkComponent>) => {
    if (!orkTree || !selectedId) return;
    setOrkTree(prev => prev ? updateComponent(prev, selectedId, updates) : prev);
    setDirty(true);
  };

  // No file loaded yet
  if (!orkTree) {
    return (
      <div className="flex-1 flex items-center justify-center"
        onDragOver={e => e.preventDefault()} onDrop={handleDrop}>
        <div className="text-center space-y-4">
          <div className="text-4xl">🔧</div>
          <p className="text-gray-400 text-sm">Drag & drop an <code className="text-blue-400">.ork</code> file here</p>
          <p className="text-gray-600 text-xs">or</p>
          <button onClick={() => fileInputRef.current?.click()}
            className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold px-6 py-2 rounded-lg transition-colors">
            Choose File
          </button>
          <input ref={fileInputRef} type="file" accept=".ork" onChange={handleFileChange} className="hidden" />
          {error && <p className="text-red-400 text-xs">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-57px)]">
      {/* Left sidebar — component tree */}
      <aside className="w-56 shrink-0 border-r border-gray-800 flex flex-col overflow-y-auto">
        <div className="p-3 border-b border-gray-800 flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-300">{orkTree.rocket_name}</span>
          <button onClick={() => { setOrkTree(null); setSelectedId(null); setOriginalOrkB64(null); setDirty(false); }}
            className="text-[10px] text-gray-500 hover:text-gray-300">Close</button>
        </div>
        <div className="p-2 space-y-0.5 flex-1 overflow-y-auto">
          {orkTree.components.map(stage => (
            <div key={stage.id}>
              <div className="px-2 py-1 text-[10px] text-gray-600 uppercase tracking-wide font-semibold">
                {TYPE_ICON.stage} {stage.name}
              </div>
              <ComponentTree
                components={stage.children ?? []}
                selectedId={selectedId}
                onSelect={setSelectedId}
                depth={0}
              />
            </div>
          ))}
        </div>
        {/* Save / Simulate buttons */}
        <div className="p-2 border-t border-gray-800 space-y-1.5">
          <button onClick={save} disabled={saving || !dirty}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-xs font-semibold px-3 py-2 rounded-lg transition-colors">
            {saving ? 'Saving…' : dirty ? 'Save .ork' : 'Saved ✓'}
          </button>
          <button onClick={simulate}
            className="w-full bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-semibold px-3 py-2 rounded-lg transition-colors">
            ▶ Simulate
          </button>
        </div>
        {error && <div className="px-2 pb-2 text-[10px] text-red-400">{error}</div>}
      </aside>

      {/* Center — canvas */}
      <div className="flex-1 flex flex-col min-w-0">
        <RocketCanvas tree={orkTree} selectedId={selectedId} />
        <div className="flex-1 flex items-center justify-center text-gray-700 text-xs">
          {selectedComp
            ? `Editing: ${selectedComp.name} (${TYPE_LABEL[selectedComp.type] ?? selectedComp.type})`
            : 'Select a component to edit'}
        </div>
      </div>

      {/* Right panel — property editor */}
      <aside className="w-72 shrink-0 border-l border-gray-800 overflow-y-auto p-3">
        {selectedComp ? (
          <PropertyEditor comp={selectedComp} onChange={handleChange} />
        ) : (
          <div className="flex items-center justify-center h-full text-gray-700 text-xs">
            Select a component
          </div>
        )}
      </aside>
    </div>
  );
}

// ── Main Design Page (mode toggle) ──────────────────────────────────────────

export function DesignPage({ setSelectedFile, setActivePage }: DesignPageProps) {
  const [mode, setMode] = useState<'chat' | 'editor'>('chat');

  return (
    <div className="flex flex-col h-[calc(100vh-57px)]">
      {/* Mode toggle */}
      <div className="flex items-center gap-1 px-4 py-1.5 border-b border-gray-800 bg-gray-950">
        <button onClick={() => setMode('chat')}
          className={`px-3 py-1 text-xs font-semibold rounded transition-colors ${
            mode === 'chat' ? 'bg-blue-600 text-white' : 'text-gray-500 hover:text-gray-300'
          }`}>
          💬 Chat
        </button>
        <button onClick={() => setMode('editor')}
          className={`px-3 py-1 text-xs font-semibold rounded transition-colors ${
            mode === 'editor' ? 'bg-blue-600 text-white' : 'text-gray-500 hover:text-gray-300'
          }`}>
          🔧 Editor
        </button>
      </div>

      {/* Mode content */}
      {mode === 'chat' ? (
        <ChatDesign setSelectedFile={setSelectedFile} setActivePage={setActivePage} />
      ) : (
        <EditorDesign setSelectedFile={setSelectedFile} setActivePage={setActivePage} />
      )}
    </div>
  );
}