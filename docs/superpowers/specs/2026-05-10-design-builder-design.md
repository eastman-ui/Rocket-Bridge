# Design Builder — Design Spec

**Goal:** Add a "Design" tab to RocketBridge where users describe their rocket in plain English and Gemini generates a ready-to-simulate OpenRocket .ork file.

**Architecture:** New third nav tab. Chat-first UI backed by a stateless `/design/chat` backend endpoint that calls the Gemini REST API via httpx (already in requirements). Gemini embeds a structured `<DESIGN>` JSON block when the design is complete; the backend strips it, generates .ork XML with Python's `xml.etree.ElementTree`, and returns the file as base64. "Simulate Now" loads the .ork into the existing simulation pipeline without leaving the app.

**Tech Stack:** React, TypeScript, FastAPI, httpx, Gemini `gemini-2.0-flash` REST API, Python xml.etree.ElementTree. No new dependencies.

---

## UI Layout

### Navigation
`ActivePage` union gains `'design'`. Nav bar renders three tabs: **Simulation · Tools · Design**.

### Design Page Structure
Two-column layout — chat on the left (flex-1), sidebar on the right (fixed 200px).

#### Sidebar
Top section — **Config** (always editable, values feed Gemini system prompt and .ork generator):
- **Altitude target** — number input, ft
- **Recovery toggle** — `Dual` / `Single` segmented control
- **Drogue deploy** — dropdown: `Apogee` / `Apogee +1s` (hidden when Single)
- **Main deploy alt.** — number input, ft (hidden when Single)

Middle section — **Design State** (fills in as Gemini works, grayed-out rows until populated):
- Tube OD, Length, Wall thickness
- Nose shape
- Fin count, Root chord, Span
- Motor designation
- Est. stability margin, Est. altitude

Bottom section — **Actions** (enabled once `ork_b64` is present in a response):
- **Download .ork** — triggers browser file download
- **Simulate Now** — creates `File` from decoded bytes, calls `setSelectedFile()` + `setActivePage('main')`
- **Start New Design** — clears messages and design state

#### Chat Panel
- Message list (scrollable, newest at bottom)
- Gemini intro bubble on mount: "Tell me about your rocket. Start with tube diameter, target altitude, and motor class — or just describe what you're trying to build."
- User messages right-aligned (blue), Gemini messages left-aligned (green)
- Text input + Send button at bottom
- Send disabled while awaiting Gemini response (shows spinner)

---

## Data Flow

### Request
`POST /design/chat`
```json
{
  "messages": [
    { "role": "user", "content": "54mm M motor, 15k ft, dual deploy" }
  ],
  "config": {
    "altitude_target_ft": 15000,
    "recovery": "dual",
    "main_deploy_ft": 700,
    "drogue_deploy": "apogee"
  }
}
```

Full conversation history sent every request (stateless backend — no session storage).

### Response
```json
{
  "message": "Here's the design. Tube is 78\" long, 4-fin trapezoidal set...",
  "design_state": {
    "tube_od_in": 2.13,
    "tube_length_in": 78,
    "nose_shape": "ogive",
    "fin_count": 4,
    "fin_root_in": 6.5,
    "fin_span_in": 3.5,
    "motor_designation": "M1350W",
    "est_margin_cal": 1.4,
    "est_altitude_ft": 14800
  },
  "ork_b64": "<base64-encoded XML string or null>"
}
```

`ork_b64` is `null` when Gemini is still gathering information. `design_state` fields are `null` for unpopulated rows (sidebar shows them grayed out).

---

## Gemini Integration

**Endpoint:** `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={GEMINI_API_KEY}`

**Called via:** `httpx.AsyncClient.post()` — no new SDK.

**API key:** `GEMINI_API_KEY` environment variable. If absent, `/design/chat` returns HTTP 503 with `{"detail": "GEMINI_API_KEY not configured"}`. Frontend shows inline warning in the Design tab instead of the chat UI.

**System prompt** (prepended to every request, not shown in message history):
```
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
{
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
}
</DESIGN>

Include explanatory text before the block. Do not output the block until the
design is complete. Ask one clarifying question at a time if needed.
```

**Backend parsing:** extract `<DESIGN>...</DESIGN>` with regex, parse JSON, pass to `generate_ork()`. Strip the block from the message text before returning to frontend.

---

## .ork XML Generation (`backend/design.py` → `generate_ork(design, config)`)

Plain XML, no zip. OpenRocket accepts it directly. All dimensions stored in **meters** (convert from inches: `× 0.0254`). OpenRocket computes CP/CG on load — do not set them.

### Component tree
```
<openrocket version="1.7" creator="RocketBridge">
  <rocket>
    <name>RocketBridge Design</name>
    <motorconfiguration configid="conf-0" default="true"/>
    <subcomponents>
      <stage>
        <subcomponents>
          <nosecone>                    shape, length, OD, wall=0.002m
          <bodytube>                    forebody: length, OD, wall
            <subcomponents>
              <trapezoidfinset>         count, root, tip, span, sweep, thickness
              <parachute>               main — dia, Cd=0.8, deploy ALTITUDE at main_deploy_m
              <parachute>               drogue — dia, Cd=0.8, deploy APOGEE (dual only)
          <bodytube>                    aft/motor mount: length = motor_length + 0.025m
            <subcomponents>
              <innertube>               motor tube, OD = motor_od
                <subcomponents>
                  <motor configid="conf-0">   designation string
```

**Single deploy:** omit drogue parachute, main uses `EJECTION_CHARGE` event instead of `ALTITUDE`.

**Motor mount length:** `motor_length_in × 0.0254 + 0.025` (1" overhang for nozzle clearance).

---

## "Simulate Now" Flow

1. Frontend decodes `ork_b64` → `Uint8Array`
2. `new File([bytes], 'design.ork', { type: 'application/octet-stream' })`
3. Calls `setSelectedFile(file)` prop (lifted from App.tsx state)
4. Calls `setActivePage('main')`
5. Simulation tab shows file loaded, user clicks Run Simulation

---

## Files Changed

| File | Change |
|---|---|
| `frontend/src/pages/DesignPage.tsx` | **Create** — full page: chat panel + sidebar with config + design state + action buttons |
| `backend/design.py` | **Create** — `chat()` async function (Gemini call + response parsing) + `generate_ork()` (.ork XML builder) |
| `frontend/src/App.tsx` | **Modify** — add `'design'` to `ActivePage` union, third nav tab, render `<DesignPage>` with `setSelectedFile` and `setActivePage` props |
| `backend/main.py` | **Modify** — add `POST /design/chat` endpoint that calls `design.chat()` |
| `docker-compose.yml` | **Modify** — add `GEMINI_API_KEY: ${GEMINI_API_KEY:-}` to backend environment |

No new npm packages. No new Python packages.

---

## Error Handling

| Scenario | Behavior |
|---|---|
| `GEMINI_API_KEY` not set | Design tab shows inline banner instead of chat: "Set GEMINI_API_KEY to use this feature" |
| Gemini API error / rate limit | Backend returns 502; frontend shows error bubble in chat, input re-enabled |
| Gemini responds without `<DESIGN>` block | Normal chat response — Gemini is still gathering info, sidebar unchanged |
| Unknown motor designation | .ork generated with motor field present; OpenRocket prompts user to select on open |
| Simulate Now clicked | Switches to Simulation tab with file pre-loaded; user clicks Run Simulation manually |
