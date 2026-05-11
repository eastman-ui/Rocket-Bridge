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
import math
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


# ── Stability calculation ─────────────────────────────────────────────────────

def _section_lengths(d: dict) -> tuple[float, float, float, float]:
    """Return (nose, fwd, switch, aft) lengths in metres."""
    ebay_len_m   = d.get("avionics_bay_length_in", 9.0) * IN_TO_M
    coupler_ext  = (ebay_len_m - SWITCH_BAND_LEN_M) / 2
    motor_len_m  = d["motor_length_in"] * IN_TO_M
    aft_len_m    = coupler_ext + DROGUE_SPACE_M + motor_len_m + NOZZLE_OVERHANG_M
    return (
        d["nose_length_in"] * IN_TO_M,
        d["fwd_bay_length_in"] * IN_TO_M,
        SWITCH_BAND_LEN_M,
        aft_len_m,
    )


def _barrowman_cp_m(d: dict) -> float:
    """Barrowman CP from nose tip, metres. Uses tangent-ogive nose + trapezoidal fin set."""
    tube_od_m = d["tube_od_in"] * IN_TO_M
    r_body    = tube_od_m / 2

    L_nose, fwd_len, sw_len, aft_len = _section_lengths(d)

    # Nose cone — tangent ogive: CNα=2, XCP = 2/3 * L_nose
    cn_nose  = 2.0
    xcp_nose = (2 / 3) * L_nose

    # Fins — Barrowman trapezoidal, N fins
    s   = d["fin_span_in"]      * IN_TO_M   # exposed semi-span (body surface to tip)
    Cr  = d["fin_root_in"]      * IN_TO_M
    Ct  = d["fin_tip_in"]       * IN_TO_M
    m_t = d["fin_sweep_in"]     * IN_TO_M   # LE sweep (root LE to tip LE, along body axis)
    N   = d["fin_count"]

    # CNα for fin set (Barrowman 1966)
    cn_fins = (4 * N * (s / tube_od_m) ** 2) / (1 + math.sqrt(1 + (2 * s / (Cr + Ct)) ** 2))
    # Body-fin interference correction
    cn_fins *= 1 + r_body / (s + r_body)

    # CP of fin set from fin root leading edge (Barrowman eq.)
    # For rectangular fin (Cr=Ct, m=0) this gives Cr/4. For delta this gives Cr/2. Verified.
    delta_xcp = (m_t * (Cr + 2 * Ct)) / (3 * (Cr + Ct)) + \
                (1 / 6) * ((Cr + Ct) - (Cr * Ct) / (Cr + Ct))

    # Fin root LE is at: nose + fwd + switch + (aft_len - root_chord)
    x_fin_root_le = L_nose + fwd_len + sw_len + (aft_len - Cr)
    xcp_fins = x_fin_root_le + delta_xcp

    # Combined CP
    cn_total = cn_nose + cn_fins
    return (cn_nose * xcp_nose + cn_fins * xcp_fins) / cn_total


def _estimate_cg_m(d: dict) -> float:
    """Simplified CG from nose tip, metres. Masses: tubes, avionics, motor estimate."""
    tube_od_m = d["tube_od_in"] * IN_TO_M
    tube_r    = tube_od_m / 2
    wall_m    = d["wall_in"] * IN_TO_M
    tube_ir   = tube_r - wall_m

    ebay_len_m  = d.get("avionics_bay_length_in", 9.0) * IN_TO_M
    coupler_ext = (ebay_len_m - SWITCH_BAND_LEN_M) / 2
    motor_len_m = d["motor_length_in"] * IN_TO_M
    motor_r     = d["motor_od_in"] * IN_TO_M / 2

    L_nose, fwd_len, sw_len, aft_len = _section_lengths(d)

    # Fiberglass tube cross-section area
    tube_area = math.pi * (tube_r ** 2 - tube_ir ** 2)

    x_nose_start = 0.0
    x_fwd_start  = L_nose
    x_sw_start   = x_fwd_start + fwd_len
    x_aft_start  = x_sw_start  + sw_len

    # Components: (mass_kg, cg_from_nose_m)
    components: list[tuple[float, float]] = [
        # Nose (hollow ogive shell ≈ half-cylinder equivalent)
        (FG_DENSITY * tube_area * L_nose * 0.5,  x_nose_start + L_nose * 0.45),
        # Forward section tube
        (FG_DENSITY * tube_area * fwd_len,         x_fwd_start + fwd_len / 2),
        # Switch band tube
        (FG_DENSITY * tube_area * sw_len,           x_sw_start  + sw_len / 2),
        # Avionics coupler (centered on switch band)
        (FG_DENSITY * math.pi * ((tube_ir - 0.001) ** 2 - (tube_ir - 0.001 - wall_m) ** 2) * ebay_len_m,
         x_sw_start - coupler_ext + ebay_len_m / 2),
        # Avionics electronics mass (at switch band)
        (d.get("avionics_mass_kg", 0.15),           x_sw_start + sw_len / 2),
        # Aft section tube
        (FG_DENSITY * tube_area * aft_len,          x_aft_start + aft_len / 2),
        # Fins (trapezoidal, fiberglass)
        (FG_DENSITY * d["fin_thickness_in"] * IN_TO_M *
         (d["fin_root_in"] + d["fin_tip_in"]) / 2 * IN_TO_M *
         d["fin_span_in"] * IN_TO_M * d["fin_count"],
         x_aft_start + aft_len - d["fin_root_in"] * IN_TO_M * 0.6),
        # Motor (full — on pad). Nozzle protrudes NOZZLE_OVERHANG_M past aft section end,
        # so motor aft face = aft_section_end + overhang (not minus).
        (d.get("motor_total_mass_kg") or 900 * math.pi * motor_r ** 2 * motor_len_m,
         x_aft_start + aft_len + NOZZLE_OVERHANG_M - motor_len_m / 2),
    ]

    total_mass = sum(m for m, _ in components)
    return sum(m * x for m, x in components) / total_mass


def _static_margin_cal(d: dict) -> float:
    """Static margin in calibers (on pad, motor full)."""
    cp  = _barrowman_cp_m(d)
    cg  = _estimate_cg_m(d)
    return (cp - cg) / (d["tube_od_in"] * IN_TO_M)


# ── ISA atmosphere ────────────────────────────────────────────────────────────

_GAMMA = 1.4
_R_AIR = 287.05  # J/(kg·K)


def _isa_atmosphere(alt_m: float) -> tuple[float, float, float]:
    """Return (temperature K, pressure Pa, speed_of_sound m/s) via ISA standard."""
    if alt_m <= 11000:
        T = 288.15 - 0.0065 * alt_m
        P = 101325.0 * (T / 288.15) ** 5.2561
    else:
        T = 216.65
        P = 22632.1 * math.exp(-0.0001577 * (alt_m - 11000))
    a = math.sqrt(_GAMMA * _R_AIR * T)
    return T, P, a


def _estimate_max_mach(altitude_ft: float) -> float:
    """Ballpark max Mach from apogee altitude for HPR (0.46 @ 5k ft → 0.8 @ 15k)."""
    return 0.8 * (altitude_ft / 15000) ** 0.5


def _flutter_safety_factor(d: dict, altitude_ft: float) -> float:
    """
    Raymer (1992) fin flutter safety factor: flutter_Mach / max_Mach.
    Evaluated at apogee pressure (conservative — lower pressure → lower flutter speed).
    G10 fiberglass shear modulus 2.62 GPa assumed.
    """
    G_shear = 2.62e9  # Pa — G10 fiberglass

    t_m    = d["fin_thickness_in"] * IN_TO_M
    Cr_m   = d["fin_root_in"]      * IN_TO_M
    Ct_m   = d["fin_tip_in"]       * IN_TO_M
    span_m = d["fin_span_in"]      * IN_TO_M

    c_mean   = (Cr_m + Ct_m) / 2.0
    fin_area = c_mean * span_m
    AR  = 2.0 * span_m ** 2 / fin_area   # aspect ratio
    lam = Ct_m / Cr_m                    # taper ratio

    _, P, a = _isa_atmosphere(altitude_ft * FT_TO_M)
    Vf = a * math.sqrt(G_shear * (t_m / c_mean) ** 3 * (AR + 2) /
                       (1.337 * AR ** 3 * P * (1 + lam)))
    flutter_mach = Vf / a
    return flutter_mach / _estimate_max_mach(altitude_ft)


def _validate_fin_flutter(d: dict, altitude_ft: float, target_sf: float = 1.2) -> dict:
    """
    Return copy of d with fin_thickness_in stepped up in 0.0625" increments until
    flutter safety factor >= target_sf (max 0.5").
    """
    d = dict(d)
    if _flutter_safety_factor(d, altitude_ft) >= target_sf:
        return d
    for _ in range(8):
        d["fin_thickness_in"] = round(d["fin_thickness_in"] + 0.0625, 4)
        if d["fin_thickness_in"] > 0.5:
            break
        if _flutter_safety_factor(d, altitude_ft) >= target_sf:
            break
    return d


_THRUSTCURVE_SEARCH = "https://www.thrustcurve.org/api/v1/search.json"


async def _get_motor_candidates(altitude_ft: float) -> list[dict]:
    """Search ThrustCurve.org by impulse class for motors appropriate for altitude."""
    import httpx

    if altitude_ft < 5000:
        classes = ["G", "H"]
    elif altitude_ft < 10000:
        classes = ["H", "I"]
    elif altitude_ft < 15000:
        classes = ["I", "J"]
    elif altitude_ft < 20000:
        classes = ["J", "K"]
    elif altitude_ft < 30000:
        classes = ["K", "L"]
    else:
        classes = ["L", "M"]

    motors: list[dict] = []
    async with httpx.AsyncClient(timeout=10) as client:
        for cls in classes:
            try:
                r = await client.get(
                    _THRUSTCURVE_SEARCH,
                    params={"impulseClass": cls, "maxResults": 6},
                )
                r.raise_for_status()
                for m in r.json().get("results", []):
                    motors.append({
                        "designation": m.get("commonName", ""),
                        "manufacturer": m.get("manufacturer", ""),
                        "impulse_class": m.get("impulseClass", cls),
                        "avg_thrust_n": m.get("avgThrustN"),
                        "total_impulse_ns": m.get("totImpulseNs"),
                        "motor_od_in": round(m.get("diameter", 0) / 25.4, 3) if m.get("diameter") else None,
                    })
            except Exception:
                pass
    return motors[:12]


def _tune_fin_span(d: dict, target_min: float = 1.0, target_max: float = 1.5) -> dict:
    """
    Return a copy of d with fin_span_in adjusted so static margin falls in
    [target_min, target_max] calibers. Steps 0.1" from 0.5" upward.
    If no single span hits the window, returns the span closest to target midpoint.
    """
    target_mid = (target_min + target_max) / 2
    d = dict(d)
    best_span, best_err = d["fin_span_in"], float("inf")

    tube_od_in = d["tube_od_in"]
    min_span = max(0.5, tube_od_in * 0.5)       # structural floor: ≥ half tube OD

    for span_tenths in range(int(min_span * 10), 121):  # min_span … 12.0"
        span = span_tenths / 10.0
        d["fin_span_in"] = span
        try:
            margin = _static_margin_cal(d)
        except Exception:
            continue
        if target_min <= margin <= target_max:
            return d                             # first hit inside window — done
        err = abs(margin - target_mid)
        if err < best_err:
            best_err, best_span = err, span

    d["fin_span_in"] = best_span
    return d


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

    # ── Auto-tune stability then validate fin flutter ─────────────────────────
    design = _tune_fin_span(design, target_min=1.0, target_max=1.3)
    altitude_ft = config.get("altitude_target_ft", 15000)
    design = _validate_fin_flutter(design, altitude_ft)

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
- Static margin: ~1.0 caliber at rail departure (10-ft standard rail)
- Thrust-to-weight: > 5:1 at liftoff
- Off-rod velocity: > 40 ft/s (12 m/s) — verify against rail length
- Main descent rate: 10–20 ft/s (target 15)
- Drogue descent rate: 40–60 ft/s
- Nose cone fineness ratio: 3:1–4:1 (length:base-diameter)
- Body tube L:D: 12:1–16:1 (sum of all three sections)

Use standard airframe tube sizes from real manufacturers (LOC, Madcow, Wildman, Apogee):
  | Diameter | OD (in)  | Wall (in) | Manufacturer examples        |
  |----------|----------|-----------|-----------------------------|
  | 29mm     | 1.225    | 0.058     | LOC, Apogee                 |
  | 38mm     | 1.635    | 0.058     | LOC, Apogee                 |
  | 54mm     | 2.26     | 0.065     | LOC, Wildman G12            |
  | 54mm     | 2.152    | 0.054     | Madcow                      |
  | 75mm     | 3.00     | 0.082     | LOC                         |
  | 75mm     | 3.15     | 0.065     | Wildman G12                 |
  | 98mm     | 3.90     | 0.082     | LOC                         |
  | 98mm     | 4.00     | 0.065     | Wildman G12                 |
  | 4-inch   | 4.024    | 0.093     | Madcow                      |
  | 6-inch   | 6.007    | 0.125     | Madcow                      |

Nose cone length: aim for 3–4× tube OD (e.g. 54mm → 7–10" nose).

Body structure (nose-to-tail):
  1. Forward Section (fwd_bay_length_in) — main parachute bay
  2. Avionics Switch Band — always 3", holds the ebay coupler
  3. Aft Section — computed from motor length; holds drogue, fins, motor

Avionics coupler (avionics_bay_length_in): the ebay tube that slides inside the
airframe spanning the switch band. Typical 8–12". Half extends into the forward
section, half into the aft section. Fwd and aft bulkheads seal the electronics bay.

Fin sizing: the backend auto-tunes fin_span_in using Barrowman equations to hit
the stability target. Supply plausible starting geometry; exact span doesn't matter.
Root ≈ 2× span, tip ≈ 0.35× root, sweep ≈ 0.29× root, count = 4, thickness = 0.125".
Fin flutter: the backend also validates flutter resistance (Raymer formula, G10 fiberglass)
and automatically increases fin_thickness_in if needed. You can still suggest 0.125".

User config: altitude target {altitude_target_ft} ft, recovery: {recovery},
main deploy: {main_deploy_ft} ft, drogue: {drogue_deploy}.

{motor_candidates}

When ready, output exactly:
<DESIGN>
{{
  "tube_od_in": <float>,
  "wall_in": <float>,
  "tube_manufacturer": <"LOC"|"Madcow"|"Wildman"|"Apogee"|"custom">,
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
  "motor_total_mass_kg": <float>,
  "drogue_dia_in": <float>,
  "main_dia_in": <float>,
  "avionics_mass_kg": <float>,
  "notes": <string>
}}
</DESIGN>

Include explanatory text before the block. Ask one clarifying question at a time.\
"""

_DESIGN_RE = re.compile(r"<DESIGN>(.*?)</DESIGN>", re.DOTALL)


def _total_length_in(d: dict) -> float | None:
    """Total rocket length nose-to-nozzle-tip in inches."""
    try:
        sections = _section_lengths(d)
        total_m = sum(sections) + NOZZLE_OVERHANG_M
        return round(total_m / IN_TO_M, 1)
    except Exception:
        return None


def _build_design_state(d: dict, config: dict | None = None) -> dict:
    altitude_ft = (config or {}).get("altitude_target_ft", 15000)
    tuned = _tune_fin_span(d, target_min=1.0, target_max=1.3)
    tuned = _validate_fin_flutter(tuned, altitude_ft)
    try:
        margin = round(_static_margin_cal(tuned), 2)
    except Exception:
        margin = None
    try:
        flutter_sf = round(_flutter_safety_factor(tuned, altitude_ft), 2)
    except Exception:
        flutter_sf = None
    try:
        dry_kg  = _estimate_rocket_dry_mass_kg(tuned)
        dry_lb  = round(dry_kg * 2.20462, 2)
        mot_kg  = tuned.get("motor_total_mass_kg") or 0
        wet_lb  = round((dry_kg + mot_kg) * 2.20462, 2)
    except Exception:
        dry_lb = wet_lb = None
    return {
        "tube_od_in":             d.get("tube_od_in"),
        "fwd_bay_length_in":      d.get("fwd_bay_length_in"),
        "avionics_bay_length_in": d.get("avionics_bay_length_in"),
        "wall_in":                d.get("wall_in"),
        "nose_shape":             d.get("nose_shape"),
        "fin_count":              tuned.get("fin_count"),
        "fin_root_in":            tuned.get("fin_root_in"),
        "fin_span_in":            tuned.get("fin_span_in"),
        "fin_thickness_in":       tuned.get("fin_thickness_in"),
        "fin_material":           d.get("fin_material"),
        "motor_designation":      d.get("motor_designation"),
        "est_margin_cal":         margin,
        "flutter_safety_factor":  flutter_sf,
        "dry_mass_lb":            dry_lb,
        "wet_mass_lb":            wet_lb,
        "total_length_in":        _total_length_in(tuned),
        "est_altitude_ft":        None,
    }


async def chat(messages: list[dict], config: dict) -> dict:
    import httpx
    api_key = os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY not configured")

    altitude_ft = config.get("altitude_target_ft", 15000)
    motor_list = await _get_motor_candidates(altitude_ft)
    if motor_list:
        lines = [f"Available motors for ~{int(altitude_ft):,} ft (from ThrustCurve.org):"]
        for m in motor_list:
            od = f"{m['motor_od_in']}\"" if m.get("motor_od_in") else "?"
            lines.append(
                f"  - {m['designation']} ({m['manufacturer']}) "
                f"| {m['impulse_class']}-class "
                f"| {od} OD "
                f"| avg {m.get('avg_thrust_n', '?')} N "
                f"| total {m.get('total_impulse_ns', '?')} N·s"
            )
        motor_section = "\n".join(lines)
    else:
        motor_section = ""

    system_text = _SYSTEM_PROMPT.format(
        altitude_target_ft=altitude_ft,
        recovery=config.get("recovery", "dual"),
        main_deploy_ft=config.get("main_deploy_ft", 700),
        drogue_deploy=config.get("drogue_deploy", "apogee"),
        motor_candidates=motor_section,
    )

    contents = []
    for m in messages:
        role = "model" if m["role"] == "assistant" else "user"
        contents.append({"role": role, "parts": [{"text": m["content"]}]})

    payload = {
        "systemInstruction": {"parts": [{"text": system_text}]},
        "contents": contents,
    }

    import asyncio as _asyncio
    url = _GEMINI_URL.format(key=api_key)
    async with httpx.AsyncClient(timeout=60) as client:
        for attempt in range(3):
            resp = await client.post(url, json=payload)
            if resp.status_code != 429:
                break
            if attempt < 2:
                await _asyncio.sleep(5 * (attempt + 1))
    resp.raise_for_status()
    text = resp.json()["candidates"][0]["content"]["parts"][0]["text"]

    ork_b64 = None
    design_state = None
    match = _DESIGN_RE.search(text)
    if match:
        design_data = json.loads(match.group(1).strip())
        design_state = _build_design_state(design_data, config)
        ork_bytes = generate_ork(design_data, config)
        ork_b64 = base64.b64encode(ork_bytes).decode()
        text = _DESIGN_RE.sub("", text).strip()

    return {"message": text, "design_state": design_state, "ork_b64": ork_b64}


# ── Deterministic design analyzer ────────────────────────────────────────────

# Shear modulus (Pa) per fin material
FIN_SHEAR_MODULUS: dict[str, float] = {
    "aluminum": 26.0e9,
    "fiberglass": 2.62e9,
    "carbon": 27.0e9,
    "plywood": 0.60e9,
}

# Standard tube sizes: OD → wall thickness (inches)
_TUBE_WALL_IN: dict[float, float] = {
    1.225: 0.058,
    1.635: 0.058,
    2.152: 0.054,
    2.26:  0.065,
    3.00:  0.082,
    3.15:  0.065,
    3.90:  0.082,
    4.00:  0.065,
    4.024: 0.093,
    6.007: 0.125,
}

_PARSE_SYSTEM = """\
Extract rocket design constraints from the user's message(s) as JSON.
Return ONLY valid JSON — no markdown fences, no extra text.

Schema (all nullable except altitude_target_ft):
{
  "tube_od_in": <float|null>,
  "tube_manufacturer": <"LOC"|"Madcow"|"Wildman"|"Apogee"|null>,
  "min_diameter": <bool>,
  "fin_material": <"aluminum"|"fiberglass"|"carbon"|"plywood"|null>,
  "fin_count": <int|null>,
  "altitude_target_ft": <float>,
  "motor_preference": <string|null>,
  "nose_length_in": <float|null>,
  "nose_length_delta_in": <float|null>,
  "fwd_bay_length_in": <float|null>,
  "fwd_bay_delta_in": <float|null>,
  "avionics_bay_length_in": <float|null>,
  "avionics_bay_delta_in": <float|null>,
  "notes": <string>
}

Rules:
- "3 inch" → tube_od_in=3.0 (user means nominal 3")
- "min diameter" / "min-dia" → min_diameter=true
- "aluminum fin can" → fin_material="aluminum"
- If motor preference given (e.g. "use the J270", "Aerotech K"), set motor_preference
- altitude_target_ft falls back to the config value if not stated in message
- "make nose 2 inches longer" → nose_length_delta_in=2.0
- "shorten forward section by 3" → fwd_bay_delta_in=-3.0
- "14 inch nose" → nose_length_in=14.0  (absolute, not delta)
- Use *_delta_in for relative changes, *_in for absolute values
"""


def _regex_parse_constraints(text: str, config: dict) -> dict:
    """
    Fast regex-based constraint extractor — no LLM required.
    Handles the most common HPR phrasings reliably.
    """
    t = text.lower()

    # Tube OD: "3 inch", "4\"", "3.9 inch", "98mm"
    tube_od = None
    m = re.search(r'(\d+(?:\.\d+)?)\s*(?:"|inch(?:es)?|in\b)', t)
    if m:
        v = float(m.group(1))
        # Snap to closest standard OD
        candidates = list(_TUBE_WALL_IN.keys())
        tube_od = min(candidates, key=lambda k: abs(k - v))
    # mm diameter: "75mm", "98mm"
    if tube_od is None:
        m = re.search(r'(\d+)\s*mm', t)
        if m:
            mm = int(m.group(1))
            # Motor size → standard tube roughly 3-4mm larger OD
            approx_od_in = (mm + 3) / 25.4
            candidates = list(_TUBE_WALL_IN.keys())
            tube_od = min(candidates, key=lambda k: abs(k - approx_od_in))

    # Min diameter
    min_dia = bool(re.search(r'min(?:imum)?\s*(?:-\s*)?diam(?:eter)?|min\s*dia', t))

    # Fin material
    fin_material = None
    if re.search(r'alum(?:inum|inium)', t):
        fin_material = "aluminum"
    elif re.search(r'carbon\s*(?:fiber|fibre|cf)', t):
        fin_material = "carbon"
    elif re.search(r'fiberglass|fg|g10|g12', t):
        fin_material = "fiberglass"
    elif re.search(r'ply(?:wood)?', t):
        fin_material = "plywood"

    # Fin count
    fin_count = None
    m = re.search(r'(\d)\s*(?:-\s*)?fin', t)
    if m:
        fin_count = int(m.group(1))

    # Altitude from message (e.g. "15k ft", "10,000 feet", "15000")
    alt_ft = config.get("altitude_target_ft", 15000)
    m = re.search(r'(\d+(?:[.,]\d+)?)\s*k?\s*(?:ft|feet|foot)', t)
    if m:
        raw_val = m.group(1).replace(",", "")
        parsed = float(raw_val)
        alt_ft = parsed * 1000 if "k" in m.group(0) else parsed

    # Motor preference: "use the J270", "K550", "Aerotech"
    motor_pref = None
    m = re.search(r'\b(?:use\s+(?:the\s+)?)?([A-Z]\d{2,4}[A-Z\-]*)', text)
    if m:
        motor_pref = m.group(1)
    if not motor_pref:
        for mfr in ("aerotech", "cesaroni", "estes", "animal motor", "loki", "kosdon"):
            if mfr in t:
                motor_pref = mfr
                break

    # ── Geometry: absolute lengths and deltas ────────────────────────────────
    # Sections: (pattern, abs_key, delta_key)
    _SECS = [
        (r'nose(?:\s+cone)?',
         'nose_length_in', 'nose_length_delta_in'),
        (r'forward\s+(?:section|bay)|fwd(?:\s+(?:section|bay))?|main\s+(?:chute\s+)?bay',
         'fwd_bay_length_in', 'fwd_bay_delta_in'),
        (r'avionics?\s+(?:bay|section)|e(?:lectronics?\s+)?bay|ebay',
         'avionics_bay_length_in', 'avionics_bay_delta_in'),
    ]
    geo: dict = {}
    for sec_pat, abs_key, delta_key in _SECS:
        # Absolute: "set/make [the] [section] [to] X [inches]"
        _m = re.search(
            rf'(?:set|make)\s+(?:the\s+)?(?:{sec_pat})\s+(?:to\s+)?(\d+(?:\.\d+)?)\s*(?:inch(?:es)?|in|")?', t)
        if _m: geo[abs_key] = float(_m.group(1)); continue
        # Absolute: "X inch [section]"
        _m = re.search(rf'(\d+(?:\.\d+)?)\s*[-\s]?(?:inch(?:es)?|in|")\s+(?:{sec_pat})', t)
        if _m: geo[abs_key] = float(_m.group(1)); continue
        # Absolute: "[section] [to] X inches"
        _m = re.search(rf'(?:{sec_pat})\s+(?:to\s+)?(\d+(?:\.\d+)?)\s*(?:inch(?:es)?|in|")', t)
        if _m: geo[abs_key] = float(_m.group(1)); continue
        # Delta: "add/increase X [in] [to/on] [section]"
        _m = re.search(
            rf'(?:add|increase|extend)\s+(\d+(?:\.\d+)?)\s*(?:inch(?:es)?|in|")?\s+(?:(?:to|on)\s+(?:the\s+)?)?(?:{sec_pat})', t)
        if not _m:
            _m = re.search(rf'(?:increase|extend)\s+(?:the\s+)?(?:{sec_pat})\s+(?:by\s+)?(\d+(?:\.\d+)?)', t)
        if _m: geo[delta_key] = float(_m.group(1)); continue
        # Delta: "[section] X [in] longer"
        _m = re.search(rf'(?:{sec_pat})\s+(\d+(?:\.\d+)?)\s*(?:inch(?:es)?|in|")?\s*longer', t)
        if _m: geo[delta_key] = float(_m.group(1)); continue
        # Delta: "make [section] X longer"
        _m = re.search(rf'make\s+(?:the\s+)?(?:{sec_pat})\s+(\d+(?:\.\d+)?)\s*(?:inch(?:es)?|in|")?\s*longer', t)
        if _m: geo[delta_key] = float(_m.group(1)); continue
        # Delta: "longer [section]" or "[section] longer" → default ±2"
        if re.search(rf'longer\s+(?:{sec_pat})|(?:{sec_pat})\s+longer', t):
            geo[delta_key] = 2.0; continue
        # Delta negative: "shorten/reduce/remove X [in] from [section]"
        _m = re.search(
            rf'(?:shorten|reduce|remove|decrease)\s+(?:(\d+(?:\.\d+)?)\s*(?:inch(?:es)?|in|")?\s+(?:from\s+)?)?(?:the\s+)?(?:{sec_pat})', t)
        if not _m:
            _m = re.search(rf'(?:{sec_pat})\s+(?:(\d+(?:\.\d+)?)\s*(?:inch(?:es)?|in|")?\s*)?shorter', t)
        if _m:
            delta = float(_m.group(1)) if _m.lastindex and _m.group(1) else 2.0
            geo[delta_key] = -delta; continue
        if re.search(rf'shorter\s+(?:{sec_pat})|(?:{sec_pat})\s+shorter', t):
            geo[delta_key] = -2.0

    return {
        "tube_od_in":             tube_od,
        "tube_manufacturer":      None,
        "min_diameter":           min_dia,
        "fin_material":           fin_material,
        "fin_count":              fin_count,
        "altitude_target_ft":     alt_ft,
        "motor_preference":       motor_pref,
        "nose_length_in":         geo.get("nose_length_in"),
        "nose_length_delta_in":   geo.get("nose_length_delta_in"),
        "fwd_bay_length_in":      geo.get("fwd_bay_length_in"),
        "fwd_bay_delta_in":       geo.get("fwd_bay_delta_in"),
        "avionics_bay_length_in": geo.get("avionics_bay_length_in"),
        "avionics_bay_delta_in":  geo.get("avionics_bay_delta_in"),
        "notes": "",
    }


async def _parse_constraints(messages: list[dict], config: dict) -> dict:
    """
    Extract structured constraints from conversation.
    Tries Gemini first; falls back to regex parser on 429 or missing key.
    """
    import httpx as _httpx

    combined = "\n".join(m["content"] for m in messages if m.get("role") == "user")

    # Try Gemini (small single call)
    api_key = os.environ.get("GEMINI_API_KEY", "")
    if api_key:
        user_text = (
            f"Config: altitude_target_ft={config.get('altitude_target_ft', 15000)}, "
            f"recovery={config.get('recovery', 'dual')}\n\nUser messages:\n{combined}"
        )
        payload = {
            "systemInstruction": {"parts": [{"text": _PARSE_SYSTEM}]},
            "contents": [{"role": "user", "parts": [{"text": user_text}]}],
            "generationConfig": {"temperature": 0.1},
        }
        url = _GEMINI_URL.format(key=api_key)
        import asyncio as _aio
        try:
            async with _httpx.AsyncClient(timeout=30) as client:
                for attempt in range(3):
                    r = await client.post(url, json=payload)
                    if r.status_code != 429:
                        break
                    if attempt < 2:
                        await _aio.sleep(5 * (attempt + 1))
            if r.status_code == 200:
                raw = r.json()["candidates"][0]["content"]["parts"][0]["text"]
                raw = re.sub(r"```(?:json)?\s*|\s*```", "", raw).strip()
                constraints = json.loads(raw)
                if not constraints.get("altitude_target_ft"):
                    constraints["altitude_target_ft"] = config.get("altitude_target_ft", 15000)
                return constraints
        except Exception:
            pass  # fall through to regex

    # Regex fallback — works without Gemini
    return _regex_parse_constraints(combined, config)


_GEO_DEFAULTS: dict[str, object] = {
    "nose_length_in":         lambda od: round(od * 3.5, 1),
    "fwd_bay_length_in":      lambda od: round(od * 5.5, 1),
    "avionics_bay_length_in": lambda _: 9.0,
}
_GEO_DELTA_MAP = {
    "nose_length_delta_in":   "nose_length_in",
    "fwd_bay_delta_in":       "fwd_bay_length_in",
    "avionics_bay_delta_in":  "avionics_bay_length_in",
}
_GEO_MIN_IN = 4.0


def _merge_constraints(parsed: dict, base: dict) -> dict:
    """
    Merge newly-parsed constraints onto previous base constraints.
    - Non-null absolute fields in parsed override base.
    - Delta fields (e.g. nose_length_delta_in) accumulate onto base absolute value.
    - Geometry values are clamped to _GEO_MIN_IN (4").
    """
    merged = dict(base)

    # Apply non-delta fields first
    for key, val in parsed.items():
        if key not in _GEO_DELTA_MAP and val is not None:
            merged[key] = val

    # Apply deltas onto resolved absolute values
    tube_od = merged.get("tube_od_in") or 3.0
    for delta_key, abs_key in _GEO_DELTA_MAP.items():
        delta = parsed.get(delta_key)
        if delta is None:
            continue
        if merged.get(abs_key) is not None:
            current = merged[abs_key]
        else:
            current = _GEO_DEFAULTS[abs_key](tube_od)
        merged[abs_key] = max(_GEO_MIN_IN, round(current + delta, 1))

    return merged


async def _search_motors_for_design(constraints: dict) -> list[dict]:
    """Query ThrustCurve by impulse class + motor diameter, return full metadata."""
    import httpx as _httpx

    altitude_ft = constraints.get("altitude_target_ft", 15000)
    motor_od_in = constraints.get("_motor_od_in", 2.953)  # resolved before calling
    motor_dia_mm = round(motor_od_in * 25.4)

    if altitude_ft < 5000:
        classes = ["G", "H"]
    elif altitude_ft < 10000:
        classes = ["H", "I"]
    elif altitude_ft < 15000:
        classes = ["I", "J"]
    elif altitude_ft < 20000:
        classes = ["J", "K"]
    elif altitude_ft < 30000:
        classes = ["K", "L"]
    else:
        classes = ["L", "M"]

    motor_pref = (constraints.get("motor_preference") or "").lower()

    motors: list[dict] = []
    async with _httpx.AsyncClient(timeout=10) as client:
        for cls in classes:
            try:
                r = await client.get(
                    _THRUSTCURVE_SEARCH,
                    params={"impulseClass": cls, "diameter": motor_dia_mm, "maxResults": 10},
                )
                r.raise_for_status()
                for m in r.json().get("results", []):
                    if m.get("availability") == "OOP":
                        continue  # skip out-of-production
                    entry = {
                        "id": m.get("motorId"),
                        "designation": m.get("commonName", ""),
                        "manufacturer": m.get("manufacturer", ""),
                        "impulse_class": m.get("impulseClass", cls),
                        "avg_thrust_n": m.get("avgThrustN"),
                        "total_impulse_ns": m.get("totImpulseNs"),
                        "burn_time_s": m.get("burnTimeS"),
                        "motor_od_mm": m.get("diameter"),
                        "motor_od_in": round(m.get("diameter", 0) / 25.4, 3),
                        "motor_len_mm": m.get("length"),
                        "motor_len_in": round(m.get("length", 0) / 25.4, 2) if m.get("length") else None,
                        "prop_mass_kg": (m.get("propWeightG") or 0) / 1000,
                    }
                    motors.append(entry)
            except Exception:
                pass

    # If motor preference mentioned, sort matching motors first
    if motor_pref:
        def _pref_key(m: dict) -> int:
            d = m["designation"].lower()
            mfr = m["manufacturer"].lower()
            return 0 if (motor_pref in d or motor_pref in mfr) else 1
        motors.sort(key=_pref_key)

    return motors


def _estimate_rocket_dry_mass_kg(design: dict) -> float:
    """Estimate dry rocket mass (no motor) in kg from tube geometry."""
    tube_od_m = design["tube_od_in"] * IN_TO_M
    tube_r    = tube_od_m / 2
    wall_m    = design["wall_in"] * IN_TO_M
    tube_ir   = tube_r - wall_m
    tube_area = math.pi * (tube_r ** 2 - tube_ir ** 2)

    L_nose, fwd_len, sw_len, aft_len = _section_lengths(design)

    tube_mass  = FG_DENSITY * tube_area * (L_nose * 0.5 + fwd_len + sw_len + aft_len)
    av_mass    = design.get("avionics_mass_kg", 0.3)
    fin_thick_m = design["fin_thickness_in"] * IN_TO_M
    fin_mass   = (
        FG_DENSITY * fin_thick_m
        * (design["fin_root_in"] + design["fin_tip_in"]) / 2 * IN_TO_M
        * design["fin_span_in"] * IN_TO_M
        * design["fin_count"]
    )
    return tube_mass + av_mass + fin_mass


def _estimate_altitude_ft(design: dict, motor: dict) -> float:
    """
    Simplified ballistic apogee estimate (vertical flight, quadratic drag).

    Uses exact coast formula: h = (1/2k) * ln(1 + k*v_bo²/g)
    where k = Cd*A*rho / (2 * m_burnout).
    """
    g   = 9.81
    Cd  = 0.40   # typical HPR min-dia
    rho = 1.225  # kg/m³ sea level (conservative — lower altitude = more drag)
    tube_od_m = design["tube_od_in"] * IN_TO_M
    A = math.pi * (tube_od_m / 2) ** 2

    prop_kg = motor.get("prop_mass_kg") or (motor.get("total_impulse_ns", 0) / (180 * g))
    # Motor hardware mass ≈ prop mass × 0.6 (typical composite reload)
    hw_kg = prop_kg * 0.6

    dry_kg = _estimate_rocket_dry_mass_kg(design)
    m_launch   = dry_kg + hw_kg + prop_kg
    m_burnout  = dry_kg + hw_kg
    m_avg      = (m_launch + m_burnout) / 2

    total_impulse = motor.get("total_impulse_ns", 0)
    # Burnout velocity via impulse-momentum (average mass), corrected 18% for drag during burn
    v_bo = (total_impulse / m_avg) * 0.82

    # Exact ballistic coast with quadratic drag
    k = (Cd * A * rho) / (2 * m_burnout)
    h_coast_m = (1 / (2 * k)) * math.log(1 + k * v_bo ** 2 / g)
    return h_coast_m / FT_TO_M


def _flutter_sf_g(d: dict, altitude_ft: float, G_pa: float) -> float:
    """Raymer flutter safety factor with explicit shear modulus G_pa (Pa)."""
    t_m    = d["fin_thickness_in"] * IN_TO_M
    Cr_m   = d["fin_root_in"]      * IN_TO_M
    Ct_m   = d["fin_tip_in"]       * IN_TO_M
    span_m = d["fin_span_in"]      * IN_TO_M
    c_mean = (Cr_m + Ct_m) / 2.0
    AR     = 2.0 * span_m ** 2 / (c_mean * span_m)
    lam    = Ct_m / Cr_m
    _, P, a = _isa_atmosphere(altitude_ft * FT_TO_M)
    Vf = a * math.sqrt(G_pa * (t_m / c_mean) ** 3 * (AR + 2) /
                       (1.337 * AR ** 3 * P * (1 + lam)))
    return (Vf / a) / _estimate_max_mach(altitude_ft)


def _build_design_for_motor(motor: dict, constraints: dict, config: dict) -> dict:
    """Assemble a complete design dict for a given motor + constraints."""
    tube_od_in    = constraints["_tube_od_in"]
    wall_in       = constraints["_wall_in"]
    fin_material  = constraints.get("fin_material") or "fiberglass"
    fin_count     = constraints.get("fin_count") or 4
    altitude_ft   = constraints.get("altitude_target_ft", 15000)
    min_dia       = constraints.get("min_diameter", False)

    # Fin proportions scaled to tube OD
    root_in  = round(tube_od_in * 1.8, 2)
    tip_in   = round(root_in * 0.35, 2)
    sweep_in = round(root_in * 0.45, 2)
    thick_in = 0.25 if fin_material == "aluminum" else 0.125

    d = {
        "tube_od_in":             tube_od_in,
        "wall_in":                wall_in,
        "tube_manufacturer":      constraints.get("_tube_manufacturer", "LOC"),
        "nose_shape":             "ogive",
        "nose_length_in":         constraints.get("nose_length_in") or round(tube_od_in * 3.5, 1),
        "fwd_bay_length_in":      constraints.get("fwd_bay_length_in") or round(tube_od_in * 5.5, 1),
        "avionics_bay_length_in": constraints.get("avionics_bay_length_in") or 9.0,
        "avionics_mass_kg":       0.30,
        "fin_material":           fin_material,
        "fin_count":              fin_count,
        "fin_root_in":            root_in,
        "fin_tip_in":             tip_in,
        "fin_sweep_in":           sweep_in,
        "fin_span_in":            round(tube_od_in * 1.2, 2),  # starting guess
        "fin_thickness_in":       thick_in,
        "motor_designation":      motor["designation"],
        "motor_manufacturer":     motor["manufacturer"],
        "motor_od_in":            motor["motor_od_in"],
        "motor_length_in":        motor["motor_len_in"],
        "motor_total_mass_kg":    motor.get("prop_mass_kg", 0) * 1.6,
        "drogue_dia_in":          round(tube_od_in * 4),
        "main_dia_in":            round(tube_od_in * 12),
    }

    # Tune fin span for stability
    d = _tune_fin_span(d, target_min=1.0, target_max=1.3)

    # Validate flutter with material-correct G
    G = FIN_SHEAR_MODULUS.get(fin_material, 2.62e9)
    sf = _flutter_sf_g(d, altitude_ft, G)
    target_sf = 1.2
    if sf < target_sf:
        for _ in range(8):
            d["fin_thickness_in"] = round(d["fin_thickness_in"] + 0.0625, 4)
            if d["fin_thickness_in"] > 0.5:
                break
            if _flutter_sf_g(d, altitude_ft, G) >= target_sf:
                break

    return d


def _format_options_text(options: list[dict], constraints: dict) -> str:
    """Format motor options as a plain-text table."""
    altitude_ft = constraints.get("altitude_target_ft", 15000)
    tube_od     = constraints.get("_tube_od_in", 3.0)
    min_dia     = constraints.get("min_diameter", False)
    fin_mat     = constraints.get("fin_material") or "fiberglass"

    lines = [
        f"{'Min-diameter' if min_dia else 'Standard'} {tube_od}\" rocket — "
        f"{int(altitude_ft):,} ft target | {fin_mat} fins",
        "",
        f"{'Motor':<12} {'Manufacturer':<22} {'Alt (ft)':<10} {'Margin':<8} {'Flutter SF':<11} {'TWR':<5}",
        "-" * 72,
    ]
    for i, o in enumerate(options[:10]):
        alt = f"{int(o['predicted_altitude_ft']):,}" if o.get("predicted_altitude_ft") else "?"
        sf  = str(o.get("flutter_sf", "?"))
        tag = "  ← best match" if i == 0 else ""
        lines.append(
            f"{o['designation']:<12} {o['manufacturer']:<22} {alt:<10} "
            f"{o['margin_cal']:<8} {sf:<11} {o.get('twr', '?'):<5}{tag}"
        )

    best_alt  = options[0].get("predicted_altitude_ft") or 0
    gap_pct   = (altitude_ft - best_alt) / altitude_ft * 100
    classes   = {o["impulse_class"] for o in options}
    lines.append("")
    if gap_pct > 25:
        multi = len(classes) > 1
        lines.append(
            f"NOTE: best match reaches ~{int(best_alt):,} ft ({gap_pct:.0f}% below {int(altitude_ft):,} ft target). "
            + (f"Options from multiple impulse classes shown above." if multi
               else "No higher-class motors found for this tube/manufacturer combo.")
        )
    lines += [
        f".ork generated for {options[0]['designation']} (best match).",
        "Click a motor card below to switch, or type 'use [designation]' to re-run.",
    ]
    return "\n".join(lines)


async def analyze(messages: list[dict], config: dict, base_constraints: dict | None = None) -> dict:
    """
    Parse natural language → search motors → rank by altitude/stability → generate .ork.
    Replaces multi-turn Gemini design conversation with a deterministic engine.
    base_constraints carries resolved state from the previous call so follow-up messages
    (e.g. "make nose longer", "only AeroTech") accumulate correctly.
    """
    # 1. Extract constraints from latest messages, then merge onto base.
    # For follow-ups (base non-empty), parse only the last user message so earlier
    # messages don't override accumulated geometry/preference changes.
    base = base_constraints or {}
    parse_msgs = [messages[-1]] if base and messages else messages
    parsed = await _parse_constraints(parse_msgs, config)
    constraints = _merge_constraints(parsed, base)
    altitude_ft = constraints.get("altitude_target_ft", config.get("altitude_target_ft", 15000))

    # 2. Resolve tube dimensions
    tube_od_raw = constraints.get("tube_od_in") or 3.00
    min_dia = constraints.get("min_diameter", False)

    if min_dia and abs(tube_od_raw - 3.0) < 0.2:
        # "3 inch min diameter" → Wildman 3.15" tube fits 75mm motor
        tube_od_in = 3.15
        wall_in = 0.065
        motor_od_in = 2.953   # 75mm motor OD
        manufacturer = "Wildman"
    else:
        # Find closest standard tube
        tube_od_in = min(_TUBE_WALL_IN, key=lambda k: abs(k - tube_od_raw))
        wall_in = _TUBE_WALL_IN[tube_od_in]
        tube_id_in = tube_od_in - 2 * wall_in
        if min_dia:
            # Snap motor OD to nearest standard size below tube ID
            std_mm = [29, 38, 54, 75, 98]
            motor_dia_mm = max((s for s in std_mm if s / 25.4 < tube_id_in - 0.05), default=54)
            motor_od_in = motor_dia_mm / 25.4
        else:
            # Use 75mm if it fits, else 54mm
            motor_od_in = 2.953 if tube_id_in > 3.05 else 2.126
        manufacturer = constraints.get("tube_manufacturer") or "LOC"

    constraints["_tube_od_in"] = tube_od_in
    constraints["_wall_in"] = wall_in
    constraints["_motor_od_in"] = motor_od_in
    constraints["_tube_manufacturer"] = manufacturer
    constraints["altitude_target_ft"] = altitude_ft

    # 3. Search motors
    motors = await _search_motors_for_design(constraints)
    motors = [m for m in motors if m.get("motor_len_in")]  # need length for design

    if not motors:
        return {
            "message": (
                f"No in-production motors found for {motor_od_in:.3f}\" OD "
                f"in the expected impulse class. Try a different tube size or altitude target."
            ),
            "motor_options": [],
            "design_state": None,
            "ork_b64": None,
        }

    # 4. Evaluate each motor
    G_pa = FIN_SHEAR_MODULUS.get(constraints.get("fin_material") or "fiberglass", 2.62e9)
    options: list[dict] = []
    for m in motors:
        try:
            d = _build_design_for_motor(m, constraints, config)
            margin = round(_static_margin_cal(d), 2)
            predicted_alt = round(_estimate_altitude_ft(d, m))
            flutter_sf = round(_flutter_sf_g(d, altitude_ft, G_pa), 2)
            dry_kg = _estimate_rocket_dry_mass_kg(d)
            total_kg = dry_kg + m.get("prop_mass_kg", 0) * 1.6
            twr = round((m.get("avg_thrust_n") or 0) / (total_kg * 9.81), 1)
            options.append({
                "designation": m["designation"],
                "manufacturer": m["manufacturer"],
                "impulse_class": m["impulse_class"],
                "predicted_altitude_ft": predicted_alt,
                "margin_cal": margin,
                "flutter_sf": flutter_sf,
                "twr": twr,
                "fin_span_in": round(d["fin_span_in"], 2),
                "fin_thickness_in": d["fin_thickness_in"],
                "motor_od_in": m["motor_od_in"],
                "total_impulse_ns": m.get("total_impulse_ns"),
                "_design": d,
            })
        except Exception:
            continue

    # 5. Apply manufacturer/designation filter if preference given
    motor_pref = (constraints.get("motor_preference") or "").lower().strip()
    if motor_pref:
        # Determine if preference is a designation (e.g. "J270") or manufacturer name
        is_designation = bool(re.match(r'^[a-z]\d{2,}', motor_pref))
        if is_designation:
            filtered = [o for o in options if motor_pref in o["designation"].lower()]
        else:
            filtered = [o for o in options if motor_pref in o["manufacturer"].lower()]
        if filtered:
            options = filtered

    # Sort: closest to target altitude first
    options.sort(key=lambda o: abs(o["predicted_altitude_ft"] - altitude_ft))

    # 5b. If best match is >30% below target, also search the next impulse class up
    if options and options[0]["predicted_altitude_ft"] < altitude_ft * 0.70:
        _cls_order = ["F", "G", "H", "I", "J", "K", "L", "M", "N"]
        current_classes = set(o["impulse_class"] for o in options)
        max_cls = max(current_classes, key=lambda c: _cls_order.index(c) if c in _cls_order else 0)
        idx = _cls_order.index(max_cls) if max_cls in _cls_order else -1
        if idx >= 0 and idx + 1 < len(_cls_order):
            next_cls = _cls_order[idx + 1]
            import httpx as _hx
            async with _hx.AsyncClient(timeout=10) as _cl:
                try:
                    _r = await _cl.get(
                        _THRUSTCURVE_SEARCH,
                        params={"impulseClass": next_cls,
                                "diameter": round(motor_od_in * 25.4),
                                "maxResults": 8},
                    )
                    for _m in _r.json().get("results", []):
                        if _m.get("availability") == "OOP" or not _m.get("length"):
                            continue
                        _entry = {
                            "id": _m.get("motorId"),
                            "designation": _m.get("commonName", ""),
                            "manufacturer": _m.get("manufacturer", ""),
                            "impulse_class": next_cls,
                            "avg_thrust_n": _m.get("avgThrustN"),
                            "total_impulse_ns": _m.get("totImpulseNs"),
                            "burn_time_s": _m.get("burnTimeS"),
                            "motor_od_in": round(_m.get("diameter", 0) / 25.4, 3),
                            "motor_len_in": round(_m.get("length", 0) / 25.4, 2),
                            "prop_mass_kg": (_m.get("propWeightG") or 0) / 1000,
                        }
                        try:
                            _d = _build_design_for_motor(_entry, constraints, config)
                            _margin = round(_static_margin_cal(_d), 2)
                            _alt = round(_estimate_altitude_ft(_d, _entry))
                            _sf = round(_flutter_sf_g(_d, altitude_ft, G_pa), 2)
                            _dry = _estimate_rocket_dry_mass_kg(_d)
                            _total = _dry + _entry.get("prop_mass_kg", 0) * 1.6
                            _twr = round((_entry.get("avg_thrust_n") or 0) / (_total * 9.81), 1)
                            options.append({
                                "designation": _entry["designation"],
                                "manufacturer": _entry["manufacturer"],
                                "impulse_class": next_cls,
                                "predicted_altitude_ft": _alt,
                                "margin_cal": _margin,
                                "flutter_sf": _sf,
                                "twr": _twr,
                                "fin_span_in": round(_d["fin_span_in"], 2),
                                "fin_thickness_in": _d["fin_thickness_in"],
                                "motor_od_in": _entry["motor_od_in"],
                                "total_impulse_ns": _entry.get("total_impulse_ns"),
                                "_design": _d,
                            })
                        except Exception:
                            continue
                except Exception:
                    pass
        # Re-apply manufacturer filter to newly added options
        if motor_pref:
            if is_designation:
                options = [o for o in options if motor_pref in o["designation"].lower()] or options
            else:
                options = [o for o in options if motor_pref in o["manufacturer"].lower()] or options
        options.sort(key=lambda o: abs(o["predicted_altitude_ft"] - altitude_ft))

    # 6. Generate .ork for best match
    best = options[0] if options else None
    ork_b64 = None
    design_state = None
    if best:
        try:
            ork_bytes = generate_ork(best["_design"], config)
            ork_b64 = base64.b64encode(ork_bytes).decode()
            design_state = _build_design_state(best["_design"], config)
        except Exception:
            pass

    # 7. Strip internal _design from returned options
    clean_options = [{k: v for k, v in o.items() if k != "_design"} for o in options]

    message = _format_options_text(options, constraints) if options else "No valid options found."

    return {
        "message": message,
        "motor_options": clean_options,
        "design_state": design_state,
        "ork_b64": ork_b64,
        "resolved_constraints": {k: v for k, v in constraints.items() if not k.startswith("_")},
    }


async def generate_ork_for_motor(
    motor_designation: str,
    motor_options: list[dict],
    constraints: dict,
    config: dict,
) -> dict:
    """
    Generate .ork for a specific motor from the already-ranked options list.
    Called when user clicks a non-best motor option.
    """
    match = next((o for o in motor_options if o["designation"] == motor_designation), None)
    if not match:
        raise ValueError(f"Motor {motor_designation!r} not in options list")

    # Rebuild design for this motor (constraints already resolved)
    motor_meta = {
        "designation":      match["designation"],
        "manufacturer":     match["manufacturer"],
        "impulse_class":    match["impulse_class"],
        "motor_od_in":      match["motor_od_in"],
        "motor_len_in":     None,   # will be resolved below
        "prop_mass_kg":     None,
        "avg_thrust_n":     None,
        "total_impulse_ns": match.get("total_impulse_ns"),
    }

    # We need motor length — re-search for it
    import httpx as _httpx
    motor_dia_mm = round(match["motor_od_in"] * 25.4)
    async with _httpx.AsyncClient(timeout=10) as client:
        r = await client.get(
            _THRUSTCURVE_SEARCH,
            params={"commonName": motor_designation, "diameter": motor_dia_mm, "maxResults": 3},
        )
        for m in r.json().get("results", []):
            if m.get("commonName") == motor_designation and m.get("length"):
                motor_meta["motor_len_in"] = round(m["length"] / 25.4, 2)
                motor_meta["prop_mass_kg"] = (m.get("propWeightG") or 0) / 1000
                motor_meta["avg_thrust_n"] = m.get("avgThrustN")
                break

    if not motor_meta["motor_len_in"]:
        raise ValueError(f"Cannot find length for {motor_designation}")

    d = _build_design_for_motor(motor_meta, constraints, config)
    ork_bytes = generate_ork(d, config)
    return {
        "ork_b64": base64.b64encode(ork_bytes).decode(),
        "design_state": _build_design_state(d, config),
    }
