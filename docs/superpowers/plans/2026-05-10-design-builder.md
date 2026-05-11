# Design Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Design tab to RocketBridge where users describe their rocket in plain English and Gemini generates a ready-to-simulate OpenRocket .ork file.

**Architecture:** Stateless chat backend at `POST /design/chat` calls Gemini REST API via httpx; parses `<DESIGN>` JSON block when design is complete; generates .ork XML with ElementTree; returns base64. New `DesignPage.tsx` provides chat UI + sidebar. App.tsx gains a third nav tab.

**Tech Stack:** React, TypeScript, FastAPI, httpx, Gemini `gemini-2.0-flash` REST API, Python `xml.etree.ElementTree`. No new dependencies.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `backend/design.py` | **Create** | `generate_ork(design, config)` → bytes; `chat(messages, config)` → dict |
| `backend/main.py` | **Modify** | Add `POST /design/chat` endpoint + request/response Pydantic models |
| `frontend/src/pages/DesignPage.tsx` | **Create** | Chat panel + config sidebar + design state + action buttons |
| `frontend/src/App.tsx` | **Modify** | `ActivePage` union, third nav tab, render DesignPage with props |
| `docker-compose.yml` | **Modify** | Add `GEMINI_API_KEY` env var to backend |

---

## Task 1: `.ork` XML Generator

**Files:**
- Create: `backend/design.py`

- [ ] **Step 1: Write the function shell with a test**

In a terminal in `backend/`, run:
```bash
python3 -c "
import design
d = {
    'tube_od_in': 2.13, 'tube_length_in': 78, 'wall_in': 0.065,
    'nose_shape': 'ogive', 'nose_length_in': 8.52,
    'fin_count': 4, 'fin_root_in': 6.5, 'fin_tip_in': 3.0,
    'fin_span_in': 3.5, 'fin_sweep_in': 2.0, 'fin_thickness_in': 0.125,
    'motor_designation': 'M1350W', 'motor_od_in': 2.1, 'motor_length_in': 25.6,
    'drogue_dia_in': 18.0, 'main_dia_in': 96.0
}
c = {'recovery': 'dual', 'main_deploy_ft': 700, 'drogue_deploy': 'apogee'}
xml = design.generate_ork(d, c)
print(xml[:200])
assert b'<openrocket' in xml
assert b'nosecone' in xml
assert b'trapezoidfinset' in xml
assert b'parachute' in xml
assert b'innertube' in xml
print('PASS')
"
```
Expected: `FAIL` with `ModuleNotFoundError: No module named 'design'`

- [ ] **Step 2: Create `backend/design.py` with `generate_ork`**

```python
import re
import os
import json
import xml.etree.ElementTree as ET

IN_TO_M = 0.0254
FT_TO_M = 0.3048


def _sub(parent: ET.Element, tag: str, **attribs) -> ET.Element:
    el = ET.SubElement(parent, tag)
    for k, v in attribs.items():
        el.set(k, str(v))
    return el


def _txt(parent: ET.Element, tag: str, text: str) -> ET.Element:
    el = ET.SubElement(parent, tag)
    el.text = text
    return el


def generate_ork(design: dict, config: dict) -> bytes:
    dual = config.get("recovery", "dual") == "dual"
    main_deploy_m = config.get("main_deploy_ft", 700) * FT_TO_M

    root = ET.Element("openrocket", version="1.7", creator="RocketBridge")
    rocket = _sub(root, "rocket")
    _txt(rocket, "name", "RocketBridge Design")
    mc = _sub(rocket, "motorconfiguration", configid="conf-0", default="true")

    stage_comps = _sub(_sub(rocket, "subcomponents"), "stage")
    sc = _sub(stage_comps, "subcomponents")

    # Nose cone
    nose = _sub(sc, "nosecone")
    _txt(nose, "name", "Nose Cone")
    _txt(nose, "shape", design["nose_shape"])
    _txt(nose, "length", f"{design['nose_length_in'] * IN_TO_M:.4f}")
    _txt(nose, "outerdiameter", f"{design['tube_od_in'] * IN_TO_M:.4f}")
    _txt(nose, "thickness", "0.002")

    # Forebody tube
    fore = _sub(sc, "bodytube")
    _txt(fore, "name", "Body Tube")
    _txt(fore, "length", f"{design['tube_length_in'] * IN_TO_M:.4f}")
    _txt(fore, "outerdiameter", f"{design['tube_od_in'] * IN_TO_M:.4f}")
    _txt(fore, "thickness", f"{design['wall_in'] * IN_TO_M:.4f}")
    fore_sc = _sub(fore, "subcomponents")

    # Fins
    fins = _sub(fore_sc, "trapezoidfinset")
    _txt(fins, "name", "Fins")
    _txt(fins, "fincount", str(design["fin_count"]))
    _txt(fins, "rootchord", f"{design['fin_root_in'] * IN_TO_M:.4f}")
    _txt(fins, "tipchord", f"{design['fin_tip_in'] * IN_TO_M:.4f}")
    _txt(fins, "height", f"{design['fin_span_in'] * IN_TO_M:.4f}")
    _txt(fins, "sweeplength", f"{design['fin_sweep_in'] * IN_TO_M:.4f}")
    _txt(fins, "thickness", f"{design['fin_thickness_in'] * IN_TO_M:.4f}")

    # Main parachute
    main_chute = _sub(fore_sc, "parachute")
    _txt(main_chute, "name", "Main")
    _txt(main_chute, "diameter", f"{design['main_dia_in'] * IN_TO_M:.4f}")
    _txt(main_chute, "cd", "0.8")
    if dual:
        _txt(main_chute, "deployevent", "ALTITUDE")
        _txt(main_chute, "deployaltitude", f"{main_deploy_m:.1f}")
    else:
        _txt(main_chute, "deployevent", "EJECTION_CHARGE")

    # Drogue (dual only)
    if dual:
        drogue = _sub(fore_sc, "parachute")
        _txt(drogue, "name", "Drogue")
        _txt(drogue, "diameter", f"{design['drogue_dia_in'] * IN_TO_M:.4f}")
        _txt(drogue, "cd", "0.8")
        _txt(drogue, "deployevent", "APOGEE")

    # Motor mount tube
    motor_len_m = design["motor_length_in"] * IN_TO_M
    mount_len_m = motor_len_m + 0.025
    aft = _sub(sc, "bodytube")
    _txt(aft, "name", "Motor Mount")
    _txt(aft, "length", f"{mount_len_m:.4f}")
    _txt(aft, "outerdiameter", f"{design['tube_od_in'] * IN_TO_M:.4f}")
    _txt(aft, "thickness", f"{design['wall_in'] * IN_TO_M:.4f}")
    aft_sc = _sub(aft, "subcomponents")

    inner = _sub(aft_sc, "innertube")
    _txt(inner, "name", "Motor Tube")
    _txt(inner, "outerdiameter", f"{design['motor_od_in'] * IN_TO_M:.4f}")
    _txt(inner, "length", f"{motor_len_m:.4f}")
    inner_sc = _sub(inner, "subcomponents")

    motor_el = _sub(inner_sc, "motor", configid="conf-0")
    _txt(motor_el, "designation", design["motor_designation"])

    return ET.tostring(root, encoding="unicode").encode()
```

- [ ] **Step 3: Run the test**

```bash
python3 -c "
import design
d = {
    'tube_od_in': 2.13, 'tube_length_in': 78, 'wall_in': 0.065,
    'nose_shape': 'ogive', 'nose_length_in': 8.52,
    'fin_count': 4, 'fin_root_in': 6.5, 'fin_tip_in': 3.0,
    'fin_span_in': 3.5, 'fin_sweep_in': 2.0, 'fin_thickness_in': 0.125,
    'motor_designation': 'M1350W', 'motor_od_in': 2.1, 'motor_length_in': 25.6,
    'drogue_dia_in': 18.0, 'main_dia_in': 96.0
}
c = {'recovery': 'dual', 'main_deploy_ft': 700, 'drogue_deploy': 'apogee'}
xml = design.generate_ork(d, c)
assert b'<openrocket' in xml
assert b'nosecone' in xml
assert b'trapezoidfinset' in xml
assert b'parachute' in xml
assert b'innertube' in xml

# Single deploy: no drogue, main uses EJECTION_CHARGE
cs = {'recovery': 'single', 'main_deploy_ft': 700, 'drogue_deploy': 'apogee'}
xs = design.generate_ork(d, cs)
assert b'EJECTION_CHARGE' in xs
assert xs.count(b'<parachute') == 1

# Dimension conversion check: 2.13in = 0.054102m
assert b'0.0541' in xml
print('PASS')
"
```
Expected: `PASS`

- [ ] **Step 4: Commit**

```bash
git add backend/design.py
git commit -m "feat: add generate_ork XML builder for Design Builder"
```

---

## Task 2: Gemini Chat Function

**Files:**
- Modify: `backend/design.py`

- [ ] **Step 1: Write the test (will pass after implementation)**

```bash
# Verify GEMINI_API_KEY is set before running
echo $GEMINI_API_KEY
```

If key is present, the live test is in Step 3. If not, skip to implementation and test endpoint-level 503 behavior in Task 3.

- [ ] **Step 2: Add `chat()` to `backend/design.py`**

Append after `generate_ork`:

```python
import base64
import httpx

_GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    "gemini-2.0-flash:generateContent?key={key}"
)

_SYSTEM_PROMPT = """\
You are a high-power rocketry design assistant integrated into RocketBridge.
The user wants to design a rocket. Ask clarifying questions one at a time until
you have enough to produce a complete design. Then output a <DESIGN> JSON block.

Design constraints to apply:
- Static margin: 1.0–1.5 calibers (CP ahead of CG by this many body diameters)
- Thrust-to-weight: > 5:1 at liftoff
- Off-rod velocity: > 40 ft/s (12 m/s)
- Main descent rate: 10–20 ft/s (target 15)
- Drogue descent rate: 40–60 ft/s
- Nose cone fineness ratio: 3:1–4:1 (length:base-diameter)
- Body tube L:D: 12:1–16:1

User config: altitude target {altitude_target_ft} ft, recovery: {recovery},
main deploy: {main_deploy_ft} ft, drogue: {drogue_deploy}.

When ready, output exactly:
<DESIGN>
{{
  "tube_od_in": <float>,
  "tube_length_in": <float>,
  "wall_in": <float>,
  "nose_shape": <"ogive"|"conical"|"elliptical"|"vonkarman"|"parabolic">,
  "nose_length_in": <float>,
  "fin_count": <int>,
  "fin_root_in": <float>,
  "fin_tip_in": <float>,
  "fin_span_in": <float>,
  "fin_sweep_in": <float>,
  "fin_thickness_in": <float>,
  "motor_designation": <string>,
  "motor_od_in": <float>,
  "motor_length_in": <float>,
  "drogue_dia_in": <float>,
  "main_dia_in": <float>,
  "notes": <string>
}}
</DESIGN>

Include explanatory text before the block. Do not output the block until the
design is complete. Ask one clarifying question at a time if needed.\
"""

_DESIGN_RE = re.compile(r"<DESIGN>(.*?)</DESIGN>", re.DOTALL)


def _build_design_state(d: dict) -> dict:
    return {
        "tube_od_in": d.get("tube_od_in"),
        "tube_length_in": d.get("tube_length_in"),
        "wall_in": d.get("wall_in"),
        "nose_shape": d.get("nose_shape"),
        "fin_count": d.get("fin_count"),
        "fin_root_in": d.get("fin_root_in"),
        "fin_span_in": d.get("fin_span_in"),
        "motor_designation": d.get("motor_designation"),
        "est_margin_cal": None,
        "est_altitude_ft": None,
    }


async def chat(messages: list[dict], config: dict) -> dict:
    api_key = os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY not configured")

    system_text = _SYSTEM_PROMPT.format(
        altitude_target_ft=config.get("altitude_target_ft", 15000),
        recovery=config.get("recovery", "dual"),
        main_deploy_ft=config.get("main_deploy_ft", 700),
        drogue_deploy=config.get("drogue_deploy", "apogee"),
    )

    # Gemini role names: "user" / "model"
    contents = []
    for m in messages:
        role = "model" if m["role"] == "assistant" else "user"
        contents.append({"role": role, "parts": [{"text": m["content"]}]})

    payload = {
        "systemInstruction": {"parts": [{"text": system_text}]},
        "contents": contents,
    }

    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            _GEMINI_URL.format(key=api_key),
            json=payload,
        )
    resp.raise_for_status()
    text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]

    # Extract <DESIGN> block if present
    ork_b64 = None
    design_state = None
    m = _DESIGN_RE.search(text)
    if m:
        raw_json = m.group(1).strip()
        design_data = json.loads(raw_json)
        design_state = _build_design_state(design_data)
        ork_bytes = generate_ork(design_data, config)
        ork_b64 = base64.b64encode(ork_bytes).decode()
        text = _DESIGN_RE.sub("", text).strip()

    return {
        "message": text,
        "design_state": design_state,
        "ork_b64": ork_b64,
    }
```

- [ ] **Step 3: Smoke test (requires `GEMINI_API_KEY`)**

```bash
python3 -c "
import asyncio, os, design
if not os.environ.get('GEMINI_API_KEY'):
    print('SKIP — no key')
    exit()
result = asyncio.run(design.chat(
    [{'role': 'user', 'content': '54mm M motor, 15k ft, dual deploy'}],
    {'altitude_target_ft': 15000, 'recovery': 'dual', 'main_deploy_ft': 700, 'drogue_deploy': 'apogee'}
))
assert 'message' in result
assert isinstance(result['message'], str) and len(result['message']) > 10
print('message:', result['message'][:120])
print('design_state:', result['design_state'])
print('ork_b64:', result['ork_b64'][:40] if result['ork_b64'] else None)
print('PASS')
"
```
Expected: `PASS` (Gemini asks a clarifying question; `design_state` and `ork_b64` are `null` until design is complete).

- [ ] **Step 4: Commit**

```bash
git add backend/design.py
git commit -m "feat: add Gemini chat() with <DESIGN> parser to design.py"
```

---

## Task 3: Backend Endpoint

**Files:**
- Modify: `backend/main.py`

- [ ] **Step 1: Add Pydantic models and import**

Open `backend/main.py`. Add to the imports at the top (after the existing `from models import ...` line):

```python
import design as design_module
```

Then add these Pydantic models after the imports section (before the route definitions):

```python
from pydantic import BaseModel as _Base

class DesignMessage(_Base):
    role: str  # "user" | "assistant"
    content: str

class DesignConfig(_Base):
    altitude_target_ft: float = 15000
    recovery: str = "dual"        # "dual" | "single"
    main_deploy_ft: float = 700
    drogue_deploy: str = "apogee" # "apogee" | "apogee+1s"

class DesignChatRequest(_Base):
    messages: list[DesignMessage]
    config: DesignConfig = DesignConfig()

class DesignState(_Base):
    tube_od_in: Optional[float] = None
    tube_length_in: Optional[float] = None
    wall_in: Optional[float] = None
    nose_shape: Optional[str] = None
    fin_count: Optional[int] = None
    fin_root_in: Optional[float] = None
    fin_span_in: Optional[float] = None
    motor_designation: Optional[str] = None
    est_margin_cal: Optional[float] = None
    est_altitude_ft: Optional[float] = None

class DesignChatResponse(_Base):
    message: str
    design_state: Optional[DesignState] = None
    ork_b64: Optional[str] = None
```

- [ ] **Step 2: Add the route**

Add after the existing route definitions (e.g., after the last `@app.` route):

```python
@app.post("/design/chat", response_model=DesignChatResponse)
async def design_chat(req: DesignChatRequest):
    api_key = os.getenv("GEMINI_API_KEY", "")
    if not api_key:
        raise HTTPException(status_code=503, detail="GEMINI_API_KEY not configured")
    try:
        result = await design_module.chat(
            [m.model_dump() for m in req.messages],
            req.config.model_dump(),
        )
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=502, detail=f"Gemini error: {e.response.status_code}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

    ds = DesignState(**result["design_state"]) if result["design_state"] else None
    return DesignChatResponse(
        message=result["message"],
        design_state=ds,
        ork_b64=result["ork_b64"],
    )
```

- [ ] **Step 3: Test the 503 case (no key)**

With backend running (`docker compose up backend` or `uvicorn main:app --reload --port 8000`):

```bash
# Temporarily unset key to test 503
GEMINI_API_KEY="" curl -s -X POST http://localhost:8080/design/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hello"}]}' | python3 -m json.tool
```
Expected: `{"detail": "GEMINI_API_KEY not configured"}` with HTTP 503.

- [ ] **Step 4: Test with a real key (if available)**

```bash
curl -s -X POST http://localhost:8080/design/chat \
  -H "Content-Type: application/json" \
  -d '{
    "messages":[{"role":"user","content":"54mm M motor, 15k ft, dual deploy"}],
    "config":{"altitude_target_ft":15000,"recovery":"dual","main_deploy_ft":700,"drogue_deploy":"apogee"}
  }' | python3 -m json.tool
```
Expected: JSON with `message` string, `design_state: null`, `ork_b64: null` (Gemini asking a clarifying question).

- [ ] **Step 5: Commit**

```bash
git add backend/main.py
git commit -m "feat: add POST /design/chat endpoint"
```

---

## Task 4: DesignPage — Sidebar + Config

**Files:**
- Create: `frontend/src/pages/DesignPage.tsx`

- [ ] **Step 1: Create component with config sidebar only**

```tsx
import { useState } from 'react';

interface DesignConfig {
  altitudeTargetFt: number;
  recovery: 'dual' | 'single';
  mainDeployFt: number;
  drogueEvent: 'apogee' | 'apogee+1s';
}

interface DesignState {
  tube_od_in: number | null;
  tube_length_in: number | null;
  wall_in: number | null;
  nose_shape: string | null;
  fin_count: number | null;
  fin_root_in: number | null;
  fin_span_in: number | null;
  motor_designation: string | null;
  est_margin_cal: number | null;
  est_altitude_ft: number | null;
}

interface DesignPageProps {
  setSelectedFile: (f: File | null) => void;
  setActivePage: (page: string) => void;
}

const EMPTY_DESIGN: DesignState = {
  tube_od_in: null, tube_length_in: null, wall_in: null,
  nose_shape: null, fin_count: null, fin_root_in: null,
  fin_span_in: null, motor_designation: null,
  est_margin_cal: null, est_altitude_ft: null,
};

function StateRow({ label, value, unit }: { label: string; value: string | number | null; unit?: string }) {
  const populated = value !== null && value !== undefined;
  return (
    <div className="flex justify-between text-xs">
      <span className="text-gray-500">{label}</span>
      <span className={populated ? 'text-gray-200' : 'text-gray-700'}>
        {populated ? `${value}${unit ? unit : ''}` : '—'}
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
  const [designState, setDesignState] = useState<DesignState>(EMPTY_DESIGN);
  const [orkB64, setOrkB64] = useState<string | null>(null);
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([
    { role: 'assistant', content: 'Tell me about your rocket. Start with tube diameter, target altitude, and motor class — or just describe what you\'re trying to build.' }
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  const dual = config.recovery === 'dual';

  return (
    <div className="flex h-[calc(100vh-53px)]">
      {/* Chat panel */}
      <div className="flex-1 flex flex-col border-r border-gray-800">
        {/* placeholder — chat panel added in Task 5 */}
        <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
          Chat panel coming in Task 5
        </div>
      </div>

      {/* Sidebar */}
      <div className="w-[200px] bg-gray-950 flex flex-col p-3 gap-3 shrink-0">

        {/* Config section */}
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-widest font-semibold mb-2">Config</div>

          <div className="space-y-2">
            {/* Altitude target */}
            <div>
              <div className="text-[10px] text-gray-400 mb-1">Altitude target</div>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  value={config.altitudeTargetFt}
                  onChange={e => setConfig(c => ({ ...c, altitudeTargetFt: Number(e.target.value) }))}
                  className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-200 w-0"
                />
                <span className="text-[10px] text-gray-600">ft</span>
              </div>
            </div>

            {/* Recovery toggle */}
            <div>
              <div className="text-[10px] text-gray-400 mb-1">Recovery</div>
              <div className="flex border border-gray-700 rounded overflow-hidden text-[10px]">
                {(['dual', 'single'] as const).map(r => (
                  <button
                    key={r}
                    onClick={() => setConfig(c => ({ ...c, recovery: r }))}
                    className={`flex-1 py-1 text-center font-medium transition-colors capitalize ${
                      config.recovery === r ? 'bg-blue-700 text-white' : 'text-gray-500 hover:text-white'
                    }`}
                  >
                    {r.charAt(0).toUpperCase() + r.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {/* Drogue (dual only) */}
            {dual && (
              <div>
                <div className="text-[10px] text-gray-400 mb-1">Drogue deploy</div>
                <select
                  value={config.drogueEvent}
                  onChange={e => setConfig(c => ({ ...c, drogueEvent: e.target.value as 'apogee' | 'apogee+1s' }))}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[10px] text-gray-200"
                >
                  <option value="apogee">Apogee</option>
                  <option value="apogee+1s">Apogee +1s</option>
                </select>
              </div>
            )}

            {/* Main deploy alt (dual only) */}
            {dual && (
              <div>
                <div className="text-[10px] text-gray-400 mb-1">Main deploy alt.</div>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    value={config.mainDeployFt}
                    onChange={e => setConfig(c => ({ ...c, mainDeployFt: Number(e.target.value) }))}
                    className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-[11px] text-gray-200 w-0"
                  />
                  <span className="text-[10px] text-gray-600">ft</span>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="h-px bg-gray-800" />

        {/* Design State section */}
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-widest font-semibold mb-2">Design State</div>
          <div className="space-y-1.5">
            <StateRow label="Tube OD" value={designState.tube_od_in} unit='"' />
            <StateRow label="Length" value={designState.tube_length_in} unit='"' />
            <StateRow label="Wall" value={designState.wall_in} unit='"' />
            <div className="h-px bg-gray-800 my-1" />
            <StateRow label="Nose" value={designState.nose_shape} />
            <div className="h-px bg-gray-800 my-1" />
            <StateRow label="Fins" value={designState.fin_count !== null ? `${designState.fin_count}×` : null} />
            <StateRow label="Root" value={designState.fin_root_in} unit='"' />
            <StateRow label="Span" value={designState.fin_span_in} unit='"' />
            <div className="h-px bg-gray-800 my-1" />
            <StateRow label="Motor" value={designState.motor_designation} />
            <StateRow
              label="Est. margin"
              value={designState.est_margin_cal !== null ? `${designState.est_margin_cal} cal` : null}
            />
            <StateRow
              label="Est. alt."
              value={designState.est_altitude_ft !== null ? `~${Math.round(designState.est_altitude_ft).toLocaleString()}` : null}
              unit=" ft"
            />
          </div>
        </div>

        <div className="flex-1" />

        {/* Action buttons — shown when ork is ready */}
        {orkB64 && (
          <div className="space-y-1.5">
            <div className="text-[10px] text-gray-500 text-center">design.ork ready</div>
            <button
              onClick={() => {
                const bytes = Uint8Array.from(atob(orkB64), c => c.charCodeAt(0));
                const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
                const a = document.createElement('a');
                a.href = url; a.download = 'design.ork'; a.click();
                URL.revokeObjectURL(url);
              }}
              className="w-full bg-blue-700 hover:bg-blue-600 text-white rounded-lg py-2 text-[11px] font-semibold transition-colors"
            >
              ⬇ Download .ork
            </button>
            <button
              onClick={() => {
                const bytes = Uint8Array.from(atob(orkB64), c => c.charCodeAt(0));
                const file = new File([bytes], 'design.ork', { type: 'application/octet-stream' });
                setSelectedFile(file);
                setActivePage('main');
              }}
              className="w-full bg-emerald-800 hover:bg-emerald-700 text-white rounded-lg py-2 text-[11px] font-semibold transition-colors"
            >
              ▶ Simulate Now
            </button>
            <button
              onClick={() => {
                setMessages([{ role: 'assistant', content: 'Tell me about your rocket. Start with tube diameter, target altitude, and motor class — or just describe what you\'re trying to build.' }]);
                setDesignState(EMPTY_DESIGN);
                setOrkB64(null);
              }}
              className="w-full border border-gray-700 text-gray-500 hover:text-white rounded-lg py-1.5 text-[10px] transition-colors"
            >
              ↺ Start New Design
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

From the `frontend/` directory:
```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/DesignPage.tsx
git commit -m "feat: add DesignPage skeleton with config sidebar and design state"
```

---

## Task 5: DesignPage — Chat Panel + Send Handler

**Files:**
- Modify: `frontend/src/pages/DesignPage.tsx`

- [ ] **Step 1: Replace the placeholder chat panel with the full implementation**

Replace the `{/* Chat panel */}` `<div>` (the first child of the outer `flex` div) with:

```tsx
      {/* Chat panel */}
      <div className="flex-1 flex flex-col">
        {/* API error banner */}
        {apiError && (
          <div className="mx-4 mt-4 bg-amber-950 border border-amber-800 rounded-lg px-3 py-2 text-xs text-amber-300">
            {apiError}
          </div>
        )}

        {/* Message list */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`max-w-[85%] rounded-xl px-3 py-2.5 text-xs leading-relaxed ${
                msg.role === 'assistant'
                  ? 'bg-green-950 border border-green-900 text-green-200 self-start'
                  : 'bg-blue-950 border border-blue-900 text-blue-200 self-end ml-auto'
              }`}
            >
              {msg.role === 'assistant' && (
                <div className="text-[10px] text-green-500 font-semibold mb-1">Gemini Design Assistant</div>
              )}
              <span className="whitespace-pre-wrap">{msg.content}</span>
            </div>
          ))}
          {loading && (
            <div className="max-w-[85%] bg-green-950 border border-green-900 rounded-xl px-3 py-2.5">
              <div className="text-[10px] text-green-500 font-semibold mb-1">Gemini Design Assistant</div>
              <div className="flex gap-1">
                {[0, 150, 300].map(d => (
                  <div
                    key={d}
                    className="w-1.5 h-1.5 bg-green-500 rounded-full animate-bounce"
                    style={{ animationDelay: `${d}ms` }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Input bar */}
        <div className="border-t border-gray-800 p-3 flex gap-2">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            disabled={loading}
            placeholder="Describe your rocket or ask Gemini to adjust the design…"
            className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-600 disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={loading || !input.trim()}
            className="bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white rounded-lg px-3 py-2 text-xs font-medium transition-colors"
          >
            {loading ? (
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : 'Send'}
          </button>
        </div>
      </div>
```

Also add the `handleSend` function inside the component, before the `return` statement:

```tsx
  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading) return;

    const newMessages: typeof messages = [...messages, { role: 'user', content: text }];
    setMessages(newMessages);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch('/api/design/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: newMessages.map(m => ({ role: m.role, content: m.content })),
          config: {
            altitude_target_ft: config.altitudeTargetFt,
            recovery: config.recovery,
            main_deploy_ft: config.mainDeployFt,
            drogue_deploy: config.drogueEvent,
          },
        }),
      });

      if (res.status === 503) {
        setApiError('Set GEMINI_API_KEY to use this feature.');
        setLoading(false);
        return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
        setMessages(m => [...m, { role: 'assistant', content: `Error: ${err.detail}` }]);
        setLoading(false);
        return;
      }

      const data = await res.json();
      setMessages(m => [...m, { role: 'assistant', content: data.message }]);
      if (data.design_state) setDesignState(data.design_state);
      if (data.ork_b64) setOrkB64(data.ork_b64);
    } catch {
      setMessages(m => [...m, { role: 'assistant', content: 'Network error — check backend connection.' }]);
    } finally {
      setLoading(false);
    }
  };
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Smoke test in browser**

Start the dev server if not running:
```bash
npm run dev
```
Open http://localhost:5175, navigate to Design tab (after Task 6). Verify:
- Intro message appears
- Typing and pressing Enter triggers the send handler
- Loading spinner shows during request
- If backend returns 503, banner appears above chat

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/DesignPage.tsx
git commit -m "feat: complete DesignPage with chat panel and send handler"
```

---

## Task 6: Wire DesignPage into App.tsx

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Add `'design'` to `ActivePage` and import `DesignPage`**

At line 12 (after the existing `ToolsPage` import):
```tsx
import { DesignPage } from './pages/DesignPage';
```

At line 18, change:
```tsx
type ActivePage = 'main' | 'tools';
```
to:
```tsx
type ActivePage = 'main' | 'tools' | 'design';
```

- [ ] **Step 2: Add Design tab to nav**

At line 297, change:
```tsx
{(['main', 'tools'] as ActivePage[]).map((p) => (
```
to:
```tsx
{(['main', 'tools', 'design'] as ActivePage[]).map((p) => (
```

At line 305, change:
```tsx
{p === 'main' ? 'Simulation' : 'Tools'}
```
to:
```tsx
{p === 'main' ? 'Simulation' : p === 'tools' ? 'Tools' : 'Design'}
```

- [ ] **Step 3: Render `<DesignPage>` and hide it when not active**

After line 385 (after the `</div>` that closes the ToolsPage wrapper div), add:

```tsx
      <div className={activePage !== 'design' ? 'hidden' : 'flex-1'}>
        <DesignPage setSelectedFile={setSelectedFile} setActivePage={setActivePage} />
      </div>
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 5: Test nav switching in browser**

With dev server running, open http://localhost:5175:
- Three tabs visible: Simulation · Tools · Design
- Clicking Design shows the DesignPage (chat intro message + sidebar)
- Clicking Simulation or Tools switches back
- No console errors

- [ ] **Step 6: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat: add Design tab to App.tsx nav and render DesignPage"
```

---

## Task 7: Add `GEMINI_API_KEY` to docker-compose.yml

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Add env var**

In `docker-compose.yml`, the `backend.environment` block currently reads:
```yaml
    environment:
      - JAVA_HOME=/opt/java/openjdk
      - OR_JAR_PATH=/opt/OpenRocket-23.09.jar
```

Add the third line:
```yaml
    environment:
      - JAVA_HOME=/opt/java/openjdk
      - OR_JAR_PATH=/opt/OpenRocket-23.09.jar
      - GEMINI_API_KEY=${GEMINI_API_KEY:-}
```

`${GEMINI_API_KEY:-}` passes the host env var through, defaulting to empty string (which triggers the 503 + banner behavior when not set).

- [ ] **Step 2: Verify compose file is valid**

```bash
docker compose config --quiet && echo "VALID"
```
Expected: `VALID`

- [ ] **Step 3: Test restart with key set**

```bash
GEMINI_API_KEY=your_key_here docker compose up backend -d
curl -s http://localhost:8080/design/chat \
  -X POST -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hello"}]}' | python3 -m json.tool
```
Expected: JSON response with a `message` field (not a 503 error).

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "feat: pass GEMINI_API_KEY through docker-compose to backend"
```

---

## End-to-End Test

After all tasks complete, test the full flow:

1. Set `GEMINI_API_KEY` in your shell
2. `docker compose up` (or start dev servers)
3. Open http://localhost:5175 → click **Design**
4. Type: `54mm airframe, M motor, 15k ft, dual deploy`
5. Follow Gemini's clarifying questions until design is complete
6. Verify sidebar populates with design values
7. Click **Download .ork** — file saves as `design.ork`
8. Click **Simulate Now** — switches to Simulation tab with file loaded
9. Click **Run Simulation** — simulation runs against the generated design
10. Click **Start New Design** — chat clears, sidebar resets
