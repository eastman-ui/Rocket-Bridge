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
  motor_designation: string | null;
  est_margin_cal: number | null;
  est_altitude_ft: number | null;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface DesignPageProps {
  setSelectedFile: (f: File | null) => void;
  setActivePage: (page: string) => void;
}

const EMPTY_DESIGN: DesignState = {
  tube_od_in: null, fwd_bay_length_in: null, avionics_bay_length_in: null,
  wall_in: null, nose_shape: null, fin_count: null, fin_root_in: null,
  fin_span_in: null, motor_designation: null,
  est_margin_cal: null, est_altitude_ft: null,
};

function StateRow({ label, value, unit }: { label: string; value: string | number | null; unit?: string }) {
  const populated = value !== null && value !== undefined;
  return (
    <div className="flex justify-between text-xs">
      <span className="text-gray-500">{label}</span>
      <span className={populated ? 'text-gray-200' : 'text-gray-700'}>
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
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;
    const newMessages: Message[] = [...messages, { role: 'user', content: text }];
    setMessages(newMessages);
    setInput('');
    setLoading(true);
    setError(null);

    try {
      const resp = await fetch('/api/design/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newMessages,
          config: {
            altitude_target_ft: config.altitudeTargetFt,
            recovery: config.recovery,
            main_deploy_ft: config.mainDeployFt,
            drogue_deploy: config.drogueEvent === 'apogee+1s' ? 'apogee' : 'apogee',
          },
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
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

  const loadIntoSimulator = () => {
    if (!orkB64) return;
    const bytes = atob(orkB64);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
    const file = new File([arr], 'rocketbridge_design.ork', { type: 'application/octet-stream' });
    setSelectedFile(file);
    setActivePage('main');
  };

  const hasDesign = Object.values(design).some(v => v !== null);

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
            <StateRow label="Est. margin" value={design.est_margin_cal} unit=" cal" />
            <StateRow label="Est. altitude" value={design.est_altitude_ft} unit=" ft" />
          </div>
        </div>

        {/* Actions */}
        {hasDesign && orkB64 && (
          <div className="space-y-2 pt-2 border-t border-gray-800">
            <p className="text-[10px] text-gray-500 uppercase tracking-wide font-semibold">Actions</p>
            <button
              onClick={loadIntoSimulator}
              className="w-full bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold px-3 py-2 rounded-lg transition-colors"
            >
              Load into Simulator
            </button>
            <button
              onClick={downloadOrk}
              className="w-full bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-medium px-3 py-2 rounded-lg transition-colors"
            >
              Download .ork
            </button>
          </div>
        )}
      </aside>

      {/* Chat panel */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {messages.length === 0 && (
            <div className="flex items-center justify-center h-full text-gray-700 text-sm">
              Describe your rocket — motor, altitude goal, diameter — and I'll design it.
            </div>
          )}
          {messages.map((m, i) => (
            <div
              key={i}
              className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                  m.role === 'user'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-900 border border-gray-800 text-gray-200'
                }`}
              >
                {m.content}
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex justify-start">
              <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-2.5 flex items-center gap-2">
                <div className="w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                <span className="text-gray-500 text-xs">Designing…</span>
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
            placeholder="Describe your rocket or answer a question…"
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
