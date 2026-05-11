"""
Design Builder backend: .ork generation and Gemini chat.

Component tree (nose→tail):
  nosecone
  bodytube "Forward Section"       ← main chute
  bodytube "Avionics Switch Band"  ← 3" outer tube; centered tubecoupler spans the break
    tubecoupler "Avionics Ebay"    ← fwd bulkhead + aft bulkhead + avionics masscomponent
  bodytube "Aft Section"           ← fins, drogue, motor innertube
    parachute "Drogue"             ← above motor (dual only)
    trapezoidfinset "Fins"         ← ao:bottom=0
    innertube "Motor Mount"        ← ao:bottom=0 [HAS MOTOR]
      centeringring (×2) + engineblock  (non-min-diameter only)
      motormount → motor
"""
import base64
import io
import json
import os
import re
import uuid
import zipfile
import xml.etree.ElementTree as ET

IN_TO_M = 0.0254
FT_TO_M = 0.3048
FG_DENSITY        = 1820.0    # Wildman G12 fiberglass, kg/m³
SWITCH_BAND_LEN_M = 0.0762    # 3" switch band outer tube
NOZZLE_OVERHANG_M = 0.0254    # 1" motor nozzle overhang
DROGUE_SPACE_M    = 0.15      # 6" min space between coupler extension and motor
CR_THICK_M        = 0.006     # 6mm centering ring thickness
BH_THICK_M        = 0.005     # 5mm bulkhead thickness


def _uid() -> str:
    return str(uuid.uuid4())


def _sub(parent: ET.Element, tag: str, **attribs) -> ET.Element:
    el = ET.SubElement(parent, tag)
    for k, v in attribs.items():
        el.set(k, str(v))
    return el


def _txt(parent: ET.Element, tag: str, text) -> ET.Element:
    el = ET.SubElement(parent, tag)
    el.text = str(text)
    return el


def _place(parent: ET.Element, method: str, value) -> None:
    """Write paired <axialoffset> + <position> (OR requires both)."""
    _sub(parent, "axialoffset", method=method).text = str(value)
    _sub(parent, "position",    type=method   ).text = str(value)


def _material(parent: ET.Element, density: float = FG_DENSITY, label: str = "Fiberglass") -> None:
    el = ET.SubElement(parent, "material")
    el.set("type", "bulk")
    el.set("density", str(density))
    el.text = label


def generate_ork(design: dict, config: dict) -> bytes:
    """
    Generate a valid OpenRocket .ork ZIP from design parameters and flight config.

    design keys:
        tube_od_in, wall_in, nose_shape, nose_length_in
        fwd_bay_length_in       — forward section (main chute bay)
        avionics_bay_length_in  — ebay coupler length (~8-12")
        avionics_mass_kg        — avionics electronics mass (default 0.15 kg)
        fin_count, fin_root_in, fin_tip_in, fin_span_in, fin_sweep_in, fin_thickness_in
        motor_designation, motor_manufacturer, motor_od_in, motor_length_in
        drogue_dia_in, main_dia_in

    config keys:
        recovery        — "dual" | "single"
        main_deploy_ft  — main chute deployment altitude in feet (default 700)
    """
    dual          = config.get("recovery", "dual") == "dual"
    main_deploy_m = config.get("main_deploy_ft", 700) * FT_TO_M
    conf_id       = _uid()

    # ── Geometry ────────────────────────────────────────────────────────────
    tube_od_m  = design["tube_od_in"] * IN_TO_M
    tube_r     = tube_od_m / 2
    wall_m     = design["wall_in"] * IN_TO_M
    tube_id_m  = tube_od_m - 2 * wall_m
    tube_ir    = tube_id_m / 2

    motor_od_m  = design["motor_od_in"] * IN_TO_M
    motor_or    = motor_od_m / 2
    motor_len_m = design["motor_length_in"] * IN_TO_M

    ebay_len_m   = design.get("avionics_bay_length_in", 9.0) * IN_TO_M
    coupler_or   = tube_ir - 0.001   # 1mm clearance to slide inside airframe
    coupler_wall = wall_m

    fwd_len_m    = design["fwd_bay_length_in"] * IN_TO_M
    coupler_ext_m = (ebay_len_m - SWITCH_BAND_LEN_M) / 2
    aft_len_m    = coupler_ext_m + DROGUE_SPACE_M + motor_len_m + NOZZLE_OVERHANG_M

    # Min-diameter: motor OD within 3mm of tube ID
    min_diameter = (tube_id_m - motor_od_m) < 0.003

    # ── XML root ─────────────────────────────────────────────────────────────
    root   = ET.Element("openrocket", version="1.9", creator="RocketBridge")
    rocket = _sub(root, "rocket")
    _txt(rocket, "name", "RocketBridge Design")
    _txt(rocket, "id", _uid())
    _place(rocket, "absolute", "0.0")
    mc = _sub(rocket, "motorconfiguration", configid=conf_id, default="true")
    _sub(mc, "stage", number="0", active="true")
    _txt(rocket, "referencetype", "maximum")

    stage = _sub(_sub(rocket, "subcomponents"), "stage")
    _txt(stage, "name", "Sustainer")
    _txt(stage, "id", _uid())
    sc = _sub(stage, "subcomponents")

    # ── Nose cone ─────────────────────────────────────────────────────────────
    nose = _sub(sc, "nosecone")
    _txt(nose, "name", "Nose Cone")
    _txt(nose, "id", _uid())
    _txt(nose, "finish", "normal")
    _material(nose)
    _txt(nose, "length", f"{design['nose_length_in'] * IN_TO_M:.4f}")
    _txt(nose, "thickness", f"{wall_m:.4f}")
    _txt(nose, "shape", design["nose_shape"])
    _txt(nose, "shapeparameter", "1.0")
    _txt(nose, "aftradius", f"{tube_r:.6f}")
    _txt(nose, "aftshoulderradius", "0.0")
    _txt(nose, "aftshoulderlength", "0.0")
    _txt(nose, "aftshoulderthickness", "0.0")
    _txt(nose, "aftshouldercapped", "false")
    _txt(nose, "isflipped", "false")
    _sub(nose, "subcomponents")

    # ── Forward Section (main chute bay) ─────────────────────────────────────
    fwd    = _sub(sc, "bodytube")
    _txt(fwd, "name", "Forward Section")
    _txt(fwd, "id", _uid())
    _txt(fwd, "finish", "normal")
    _material(fwd)
    _txt(fwd, "length", f"{fwd_len_m:.4f}")
    _txt(fwd, "thickness", f"{wall_m:.4f}")
    _txt(fwd, "radius", f"{tube_r:.6f}")
    fwd_sc = _sub(fwd, "subcomponents")

    main_chute = _sub(fwd_sc, "parachute")
    _txt(main_chute, "name", "Main")
    _txt(main_chute, "id", _uid())
    _place(main_chute, "middle", "0.0")
    _txt(main_chute, "packedlength", "0.20")
    _txt(main_chute, "packedradius", f"{tube_ir * 0.9:.4f}")
    _txt(main_chute, "radialposition", "0.0")
    _txt(main_chute, "radialdirection", "0.0")
    _txt(main_chute, "cd", "0.8")
    _txt(main_chute, "deployevent", "altitude" if dual else "ejection")
    _txt(main_chute, "deployaltitude", f"{main_deploy_m:.1f}")
    _txt(main_chute, "deploydelay", "0.0")
    _txt(main_chute, "diameter", f"{design['main_dia_in'] * IN_TO_M:.4f}")
    _txt(main_chute, "linecount", "6")
    _txt(main_chute, "linelength", f"{design['main_dia_in'] * IN_TO_M:.4f}")
    lm = ET.SubElement(main_chute, "linematerial")
    lm.set("type", "line"); lm.set("density", "0.0165"); lm.text = "Nylon cord"

    # ── Avionics Switch Band ──────────────────────────────────────────────────
    # Short (3") outer tube. The ebay coupler sits centered inside it (ao:middle=0)
    # and extends into both the forward and aft sections. Pattern from Rev19 design.
    switch    = _sub(sc, "bodytube")
    _txt(switch, "name", "Avionics Switch Band")
    _txt(switch, "id", _uid())
    _txt(switch, "finish", "normal")
    _material(switch)
    _txt(switch, "length", f"{SWITCH_BAND_LEN_M:.4f}")
    _txt(switch, "thickness", f"{wall_m:.4f}")
    _txt(switch, "radius", f"{tube_r:.6f}")
    sw_sc = _sub(switch, "subcomponents")

    coupler = _sub(sw_sc, "tubecoupler")
    _txt(coupler, "name", "Avionics Ebay")
    _txt(coupler, "id", _uid())
    _place(coupler, "middle", "0.0")
    _material(coupler)
    _txt(coupler, "length", f"{ebay_len_m:.4f}")
    _txt(coupler, "radialposition", "0.0")
    _txt(coupler, "radialdirection", "0.0")
    _txt(coupler, "outerradius", f"{coupler_or:.6f}")
    _txt(coupler, "thickness", f"{coupler_wall:.4f}")
    coupler_sc = _sub(coupler, "subcomponents")

    # Forward bulkhead (nose end of ebay)
    # ao:bottom convention: negative = inside coupler from its aft end (toward nose)
    bh_fwd = _sub(coupler_sc, "bulkhead")
    _txt(bh_fwd, "name", "Fwd Bulkhead")
    _txt(bh_fwd, "id", _uid())
    _place(bh_fwd, "bottom", f"{-(ebay_len_m - BH_THICK_M):.4f}")
    _material(bh_fwd)
    _txt(bh_fwd, "length", f"{BH_THICK_M:.4f}")
    _txt(bh_fwd, "radialposition", "0.0")
    _txt(bh_fwd, "radialdirection", "0.0")
    _txt(bh_fwd, "outerradius", f"{coupler_or:.6f}")

    # Aft bulkhead (motor end of ebay)
    bh_aft = _sub(coupler_sc, "bulkhead")
    _txt(bh_aft, "name", "Aft Bulkhead")
    _txt(bh_aft, "id", _uid())
    _place(bh_aft, "bottom", f"{BH_THICK_M:.4f}")
    _material(bh_aft)
    _txt(bh_aft, "length", f"{BH_THICK_M:.4f}")
    _txt(bh_aft, "radialposition", "0.0")
    _txt(bh_aft, "radialdirection", "0.0")
    _txt(bh_aft, "outerradius", f"{coupler_or:.6f}")

    av_mass = _sub(coupler_sc, "masscomponent")
    _txt(av_mass, "name", "Avionics")
    _txt(av_mass, "id", _uid())
    _place(av_mass, "middle", "0.0")
    _txt(av_mass, "packedlength", f"{ebay_len_m * 0.6:.4f}")
    _txt(av_mass, "packedradius", f"{coupler_or * 0.7:.4f}")
    _txt(av_mass, "radialposition", "0.0")
    _txt(av_mass, "radialdirection", "0.0")
    _txt(av_mass, "mass", f"{design.get('avionics_mass_kg', 0.15):.4f}")
    _txt(av_mass, "masscomponenttype", "flightcomputer")

    # ── Aft Section ───────────────────────────────────────────────────────────
    # NOT named "fin can" — it IS the aft outer airframe.
    # Fins and motor innertube are siblings here at ao:bottom=0.
    aft    = _sub(sc, "bodytube")
    _txt(aft, "name", "Aft Section")
    _txt(aft, "id", _uid())
    _txt(aft, "finish", "normal")
    _material(aft)
    _txt(aft, "length", f"{aft_len_m:.4f}")
    _txt(aft, "thickness", f"{wall_m:.4f}")
    _txt(aft, "radius", f"{tube_r:.6f}")
    aft_sc = _sub(aft, "subcomponents")

    # Drogue — positioned below the coupler extension, above the motor
    if dual:
        drogue = _sub(aft_sc, "parachute")
        _txt(drogue, "name", "Drogue")
        _txt(drogue, "id", _uid())
        drogue_offset_m = coupler_ext_m + 0.025
        _place(drogue, "top", f"{drogue_offset_m:.4f}")
        _txt(drogue, "packedlength", "0.10")
        _txt(drogue, "packedradius", f"{tube_ir * 0.9:.4f}")
        _txt(drogue, "radialposition", "0.0")
        _txt(drogue, "radialdirection", "0.0")
        _txt(drogue, "cd", "0.8")
        _txt(drogue, "deployevent", "apogee")
        _txt(drogue, "deployaltitude", "0.0")
        _txt(drogue, "deploydelay", "0.0")
        _txt(drogue, "diameter", f"{design['drogue_dia_in'] * IN_TO_M:.4f}")
        _txt(drogue, "linecount", "4")
        _txt(drogue, "linelength", f"{design['drogue_dia_in'] * IN_TO_M:.4f}")
        dlm = ET.SubElement(drogue, "linematerial")
        dlm.set("type", "line"); dlm.set("density", "0.0165"); dlm.text = "Nylon cord"

    # Fins — siblings of motor innertube, at aft end of aft section
    fins = _sub(aft_sc, "trapezoidfinset")
    _txt(fins, "name", "Fins")
    _txt(fins, "id", _uid())
    _txt(fins, "instancecount", str(design["fin_count"]))
    _txt(fins, "fincount", str(design["fin_count"]))
    _sub(fins, "radiusoffset", method="surface").text = "0.0"
    _sub(fins, "angleoffset", method="relative").text = "0.0"
    _txt(fins, "rotation", "0.0")
    _place(fins, "bottom", "0.0")
    _txt(fins, "finish", "normal")
    _material(fins)
    _txt(fins, "thickness", f"{design['fin_thickness_in'] * IN_TO_M:.4f}")
    _txt(fins, "crosssection", "square")
    _txt(fins, "cant", "0.0")
    _txt(fins, "rootchord", f"{design['fin_root_in'] * IN_TO_M:.4f}")
    _txt(fins, "tipchord", f"{design['fin_tip_in'] * IN_TO_M:.4f}")
    _txt(fins, "height", f"{design['fin_span_in'] * IN_TO_M:.4f}")
    _txt(fins, "sweeplength", f"{design['fin_sweep_in'] * IN_TO_M:.4f}")
    _sub(fins, "subcomponents")

    # Motor innertube — at aft end of aft section
    inner = _sub(aft_sc, "innertube")
    _txt(inner, "name", "Motor Mount")
    _txt(inner, "id", _uid())
    _place(inner, "bottom", "0.0")
    if min_diameter:
        el = ET.SubElement(inner, "material")
        el.set("type", "bulk"); el.set("density", "0.0"); el.text = "air"
        _txt(inner, "thickness", f"{0.001 * IN_TO_M:.6f}")
    else:
        _material(inner)
        _txt(inner, "thickness", f"{wall_m:.4f}")
    _txt(inner, "length", f"{motor_len_m:.4f}")
    _txt(inner, "radialposition", "0.0")
    _txt(inner, "radialdirection", "0.0")
    _txt(inner, "outerradius", f"{motor_or:.6f}")
    _txt(inner, "clusterconfiguration", "single")
    _txt(inner, "clusterscale", "1.0")
    _txt(inner, "clusterrotation", "0.0")
    inner_sc = _sub(inner, "subcomponents")

    if not min_diameter:
        # Aft centering ring — just past motor tube aft end
        cr_aft = _sub(inner_sc, "centeringring")
        _txt(cr_aft, "name", "Aft Centering Ring")
        _txt(cr_aft, "id", _uid())
        _place(cr_aft, "bottom", f"{CR_THICK_M:.4f}")
        _material(cr_aft)
        _txt(cr_aft, "length", f"{CR_THICK_M:.4f}")
        _txt(cr_aft, "radialposition", "0.0")
        _txt(cr_aft, "radialdirection", "0.0")
        _txt(cr_aft, "outerradius", "auto")
        _txt(cr_aft, "innerradius", f"{motor_or:.6f}")

        # Forward centering ring — 50mm from motor tube forward end
        cr_fwd = _sub(inner_sc, "centeringring")
        _txt(cr_fwd, "name", "Forward Centering Ring")
        _txt(cr_fwd, "id", _uid())
        _place(cr_fwd, "bottom", f"{-(motor_len_m - 0.05):.4f}")
        _material(cr_fwd)
        _txt(cr_fwd, "length", f"{CR_THICK_M:.4f}")
        _txt(cr_fwd, "radialposition", "0.0")
        _txt(cr_fwd, "radialdirection", "0.0")
        _txt(cr_fwd, "outerradius", "auto")
        _txt(cr_fwd, "innerradius", f"{motor_or:.6f}")

        # Engine block (thrust plate)
        eb = _sub(inner_sc, "engineblock")
        _txt(eb, "name", "Engine Block")
        _txt(eb, "id", _uid())
        _place(eb, "bottom", "0.003")
        _material(eb)
        _txt(eb, "length", "0.005")
        _txt(eb, "radialposition", "0.0")
        _txt(eb, "radialdirection", "0.0")
        _txt(eb, "outerradius", f"{motor_or:.6f}")
        _txt(eb, "innerradius", f"{motor_or * 0.5:.6f}")

    mm = _sub(inner, "motormount")
    _txt(mm, "ignitionevent", "automatic")
    _txt(mm, "ignitiondelay", "0.0")
    _txt(mm, "overhang", f"{NOZZLE_OVERHANG_M:.4f}")

    motor_el = _sub(mm, "motor", configid=conf_id)
    _txt(motor_el, "type", "reload")
    _txt(motor_el, "manufacturer", design.get("motor_manufacturer", ""))
    _txt(motor_el, "designation", design["motor_designation"])
    _txt(motor_el, "diameter", f"{motor_od_m:.4f}")
    _txt(motor_el, "length", f"{motor_len_m:.4f}")
    _txt(motor_el, "delay", "0.0")

    igconf = _sub(mm, "ignitionconfiguration", configid=conf_id)
    _txt(igconf, "ignitionevent", "automatic")
    _txt(igconf, "ignitiondelay", "0.0")

    # ── ZIP output ────────────────────────────────────────────────────────────
    xml_str = "<?xml version='1.0' encoding='utf-8'?>\n"
    xml_str += ET.tostring(root, encoding="unicode")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("rocket.ork", xml_str.encode("utf-8"))
    return buf.getvalue()


# ── Gemini system prompt ───────────────────────────────────────────────────────
_GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    "gemini-2.0-flash:generateContent?key={key}"
)

_SYSTEM_PROMPT = """\
You are a high-power rocketry design assistant integrated into RocketBridge.
Ask clarifying questions one at a time until you have enough to produce a complete
design, then output a <DESIGN> JSON block.

Design constraints:
- Static margin: 1.0–1.5 calibers
- Thrust-to-weight: > 5:1 at liftoff
- Off-rod velocity: > 40 ft/s (12 m/s)
- Main descent rate: 10–20 ft/s (target 15)
- Drogue descent rate: 40–60 ft/s
- Nose cone fineness ratio: 3:1–4:1 (length:base-diameter)
- Body tube L:D: 12:1–16:1 (sum of all three sections)

Body structure (nose-to-tail):
  1. Forward Section (fwd_bay_length_in) — main parachute bay
  2. Avionics Switch Band — always 3", holds the ebay coupler
  3. Aft Section — computed from motor length; holds drogue, fins, motor

Avionics coupler (avionics_bay_length_in): the ebay tube that slides inside the
airframe spanning the switch band. Typical 8–12". Half extends into the forward
section, half into the aft section. Fwd and aft bulkheads seal the electronics bay.

Fin sizing: size fins to achieve 1.0–1.5 cal static margin using Barrowman
equations. For a min-diameter build, fins typically need 4–6" span.

User config: altitude target {altitude_target_ft} ft, recovery: {recovery},
main deploy: {main_deploy_ft} ft, drogue: {drogue_deploy}.

When ready, output exactly:
<DESIGN>
{{
  "tube_od_in": <float>,
  "wall_in": <float>,
  "nose_shape": <"ogive"|"conical"|"elliptical"|"vonkarman"|"parabolic">,
  "nose_length_in": <float>,
  "fwd_bay_length_in": <float>,
  "avionics_bay_length_in": <float>,
  "fin_count": <int>,
  "fin_root_in": <float>,
  "fin_tip_in": <float>,
  "fin_span_in": <float>,
  "fin_sweep_in": <float>,
  "fin_thickness_in": <float>,
  "motor_designation": <string>,
  "motor_manufacturer": <string>,
  "motor_od_in": <float>,
  "motor_length_in": <float>,
  "drogue_dia_in": <float>,
  "main_dia_in": <float>,
  "avionics_mass_kg": <float>,
  "notes": <string>
}}
</DESIGN>

Include explanatory text before the block. Ask one clarifying question at a time.\
"""

_DESIGN_RE = re.compile(r"<DESIGN>(.*?)</DESIGN>", re.DOTALL)


def _build_design_state(d: dict) -> dict:
    return {
        "tube_od_in": d.get("tube_od_in"),
        "fwd_bay_length_in": d.get("fwd_bay_length_in"),
        "avionics_bay_length_in": d.get("avionics_bay_length_in"),
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
    import httpx
    api_key = os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY not configured")

    system_text = _SYSTEM_PROMPT.format(
        altitude_target_ft=config.get("altitude_target_ft", 15000),
        recovery=config.get("recovery", "dual"),
        main_deploy_ft=config.get("main_deploy_ft", 700),
        drogue_deploy=config.get("drogue_deploy", "apogee"),
    )

    contents = []
    for m in messages:
        role = "model" if m["role"] == "assistant" else "user"
        contents.append({"role": role, "parts": [{"text": m["content"]}]})

    payload = {
        "systemInstruction": {"parts": [{"text": system_text}]},
        "contents": contents,
    }

    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(_GEMINI_URL.format(key=api_key), json=payload)
    resp.raise_for_status()
    text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]

    ork_b64 = None
    design_state = None
    match = _DESIGN_RE.search(text)
    if match:
        design_data = json.loads(match.group(1).strip())
        design_state = _build_design_state(design_data)
        ork_bytes = generate_ork(design_data, config)
        ork_b64 = base64.b64encode(ork_bytes).decode()
        text = _DESIGN_RE.sub("", text).strip()

    return {"message": text, "design_state": design_state, "ork_b64": ork_b64}
