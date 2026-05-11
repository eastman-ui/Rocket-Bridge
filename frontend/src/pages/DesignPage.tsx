import { useState, useRef, useEffect } from 'react';

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

export function DesignPage({ setSelectedFile, setActivePage }: DesignPageProps) {
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

  const downloadOrk = () => {
    if (!orkB64) return;
    const bytes = atob(orkB64);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    const blob = new Blob([arr], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'rocketbridge_design.ork'; a.click();
    URL.revokeObjectURL(url);
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
        {/* Config */}
        <div className="space-y-3">
          <p className="text-[10px] text-gray-500 uppercase tracking-wide font-semibold">Flight Config</p>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-400">Target Altitude (ft)</span>
            <input
              type="number" step="500" min="1000" max="50000"
              value={config.altitudeTargetFt}
              onChange={e => setConfig(c => ({ ...c, altitudeTargetFt: Number(e.target.value) }))}
              className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-1 text-xs text-white"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-400">Recovery</span>
            <select
              value={config.recovery}
              onChange={e => setConfig(c => ({ ...c, recovery: e.target.value as 'dual' | 'single' }))}
              className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-1 text-xs text-white"
            >
              <option value="dual">Dual Deploy</option>
              <option value="single">Single Deploy</option>
            </select>
          </label>

          {config.recovery === 'dual' && (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-400">Main Deploy (ft AGL)</span>
              <input
                type="number" step="50" min="200" max="2000"
                value={config.mainDeployFt}
                onChange={e => setConfig(c => ({ ...c, mainDeployFt: Number(e.target.value) }))}
                className="bg-gray-900 border border-gray-700 rounded-lg px-2 py-1 text-xs text-white"
              />
            </label>
          )}
        </div>

        {/* Design State */}
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
            <StateRow
              label="Flutter SF"
              value={design.flutter_safety_factor}
              color={sfColor(design.flutter_safety_factor)}
            />
            <StateRow label="Est. altitude" value={design.est_altitude_ft} unit=" ft" />
          </div>
        </div>

        {/* Actions */}
        {hasDesign && orkB64 && (
          <div className="space-y-2 pt-2 border-t border-gray-800">
            <p className="text-[10px] text-gray-500 uppercase tracking-wide font-semibold">Actions</p>
            <button
              onClick={downloadOrk}
              className="w-full bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold px-3 py-2 rounded-lg transition-colors"
            >
              Download .ork
            </button>
            <p className="text-[10px] text-gray-600 leading-relaxed">
              Open in OpenRocket → run simulation → re-upload to the Simulate tab.
            </p>
          </div>
        )}
      </aside>

      {/* Chat + options panel */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {messages.length === 0 && (
            <div className="flex items-center justify-center h-full text-gray-700 text-sm text-center px-8">
              Describe your rocket — diameter, motor preference, altitude goal — and I'll rank matching motors and generate a ready-to-fly .ork file.
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[85%] rounded-xl px-4 py-2.5 text-sm ${
                  m.role === 'user'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-900 border border-gray-800 text-gray-200 font-mono text-xs whitespace-pre-wrap'
                }`}
              >
                {m.content}
              </div>
            </div>
          ))}

          {/* Motor options cards */}
          {motorOptions.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] text-gray-500 uppercase tracking-wide font-semibold px-1">Motor Options</p>
              {motorOptions.slice(0, 10).map((opt) => {
                const isSelected = opt.designation === selectedMotor;
                const isLoading = opt.designation === selectingMotor;
                return (
                  <div
                    key={opt.designation}
                    className={`rounded-xl border px-4 py-3 flex items-center justify-between gap-3 transition-colors ${
                      isSelected
                        ? 'border-blue-500 bg-blue-950/40'
                        : 'border-gray-800 bg-gray-900/60 hover:border-gray-700'
                    }`}
                  >
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
                          {opt.predicted_altitude_ft != null
                            ? `~${opt.predicted_altitude_ft.toLocaleString()} ft`
                            : '? ft'}
                        </span>
                        <span className="text-gray-500">
                          margin {opt.margin_cal ?? '?'} cal
                        </span>
                        <span className={sfColor(opt.flutter_sf) ?? 'text-gray-500'}>
                          flutter {opt.flutter_sf ?? '?'}×
                        </span>
                        <span className="text-gray-500">TWR {opt.twr ?? '?'}</span>
                        <span className="text-gray-600">
                          {opt.fin_span_in}" span · {opt.fin_thickness_in}" thick
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={() => selectMotor(opt.designation)}
                      disabled={isSelected || !!selectingMotor}
                      className={`shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors ${
                        isSelected
                          ? 'bg-blue-600 text-white cursor-default'
                          : 'bg-gray-800 hover:bg-gray-700 text-gray-300 disabled:opacity-40'
                      }`}
                    >
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
            <div className="bg-red-950 border border-red-800 rounded-xl px-4 py-2.5 text-xs text-red-300">
              {error}
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="border-t border-gray-800 px-4 py-3 flex gap-2">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe your rocket — diameter, min-diameter, fin material, altitude goal…"
            rows={2}
            disabled={loading}
            className="flex-1 bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 resize-none focus:outline-none focus:border-blue-600 disabled:opacity-50"
          />
          <button
            onClick={send}
            disabled={!input.trim() || loading}
            className="self-end bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold px-4 py-2 rounded-xl transition-colors"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
