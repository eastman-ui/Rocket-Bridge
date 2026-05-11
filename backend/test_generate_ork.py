"""
Standalone test: generate a min-diameter 54mm dual-deploy .ork file.
Run from backend/: python3 test_generate_ork.py

Structure validated against 5 real .ork files (L3, Senior Design, MinD, Axiom, Rev19).

Component tree (nose→tail):
  nosecone
  bodytube "Forward Section"       ← main chute lives here
  bodytube "Avionics Switch Band"  ← 3" outer tube; centered tubecoupler spans the break
    tubecoupler "Avionics Ebay"    ← coupler: fwd bulkhead + aft bulkhead + avionics mass
  bodytube "Aft Section"           ← NOT a "fin can" bodytube
    parachute "Drogue"             ← near top, between coupler extension and motor
    trapezoidfinset "Fins"         ← ao:bottom=0 (aft end of aft section)
    innertube "Motor Mount"        ← ao:bottom=0; [MOTOR]
      centeringring "Forward CR"   ← inside motor tube (non-min-diam only)
      centeringring "Aft CR"       ← inside motor tube (non-min-diam only)
      engineblock                  ← thrust plate (non-min-diam only)
      motormount → motor

ao:bottom sign convention (confirmed from real files):
  positive = component protrudes past parent aft end (toward nozzle)
  negative = component is |value| meters inside parent from its aft end (toward nose)
  zero     = component aft end aligns with parent aft end
"""
import io
import uuid
import zipfile
import xml.etree.ElementTree as ET

IN_TO_M = 0.0254
FT_TO_M = 0.3048
FG_DENSITY = 1820.0   # Wildman G12 fiberglass, kg/m³
SWITCH_BAND_LEN_M = 0.0762   # 3" — standard switch band / separation section
NOZZLE_OVERHANG_M = 0.0254   # 1" motor nozzle overhang past aft end
DROGUE_SPACE_M    = 0.15     # 6" minimum between coupler extension and motor forward end
CR_THICK_M        = 0.006    # 6mm centering ring thickness
BH_THICK_M        = 0.005    # 5mm bulkhead thickness


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
    dual            = config.get("recovery", "dual") == "dual"
    main_deploy_m   = config.get("main_deploy_ft", 700) * FT_TO_M
    conf_id         = _uid()

    # ── Geometry ────────────────────────────────────────────────────────────
    tube_od_m   = design["tube_od_in"] * IN_TO_M
    tube_r      = tube_od_m / 2           # outer radius of airframe
    wall_m      = design["wall_in"] * IN_TO_M
    tube_id_m   = tube_od_m - 2 * wall_m
    tube_ir     = tube_id_m / 2           # inner radius of airframe

    motor_od_m  = design["motor_od_in"] * IN_TO_M
    motor_or    = motor_od_m / 2
    motor_len_m = design["motor_length_in"] * IN_TO_M

    # Avionics ebay coupler — OD = tube ID minus 1mm clearance (slides inside airframe)
    ebay_len_m   = design.get("avionics_bay_length_in", 9.0) * IN_TO_M
    coupler_or   = tube_ir - 0.001
    coupler_wall = wall_m

    # Section lengths
    fwd_len_m  = design["fwd_bay_length_in"] * IN_TO_M
    # Coupler extends (ebay_len - switch_band) / 2 into each adjacent tube
    coupler_ext_m = (ebay_len_m - SWITCH_BAND_LEN_M) / 2
    aft_len_m  = coupler_ext_m + DROGUE_SPACE_M + motor_len_m + NOZZLE_OVERHANG_M

    # Min-diameter: motor fills the tube within 3 mm clearance
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

    # ── Avionics Switch Band (short outer tube holding the ebay coupler) ───────
    # Pattern from Rev19: 3" outer bodytube, tubecoupler centered (ao:middle=0),
    # coupler length >> switch band length so it extends into both adjacent tubes.
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
    _place(coupler, "middle", "0.0")   # centered — extends equally into fwd and aft sections
    _material(coupler)
    _txt(coupler, "length", f"{ebay_len_m:.4f}")
    _txt(coupler, "radialposition", "0.0")
    _txt(coupler, "radialdirection", "0.0")
    _txt(coupler, "outerradius", f"{coupler_or:.6f}")
    _txt(coupler, "thickness", f"{coupler_wall:.4f}")
    coupler_sc = _sub(coupler, "subcomponents")

    # Forward bulkhead — nose end of ebay
    # ao:bottom convention: negative = inside coupler from its aft end (toward nose)
    # -(ebay_len - BH_THICK) places this at the forward (nose) end of the coupler
    bh_fwd = _sub(coupler_sc, "bulkhead")
    _txt(bh_fwd, "name", "Fwd Bulkhead")
    _txt(bh_fwd, "id", _uid())
    _place(bh_fwd, "bottom", f"{-(ebay_len_m - BH_THICK_M):.4f}")
    _material(bh_fwd)
    _txt(bh_fwd, "length", f"{BH_THICK_M:.4f}")
    _txt(bh_fwd, "radialposition", "0.0")
    _txt(bh_fwd, "radialdirection", "0.0")
    _txt(bh_fwd, "outerradius", f"{coupler_or:.6f}")

    # Aft bulkhead — motor end of ebay
    # ao:bottom=small positive: just past coupler aft end (seals the aft face)
    bh_aft = _sub(coupler_sc, "bulkhead")
    _txt(bh_aft, "name", "Aft Bulkhead")
    _txt(bh_aft, "id", _uid())
    _place(bh_aft, "bottom", f"{BH_THICK_M:.4f}")
    _material(bh_aft)
    _txt(bh_aft, "length", f"{BH_THICK_M:.4f}")
    _txt(bh_aft, "radialposition", "0.0")
    _txt(bh_aft, "radialdirection", "0.0")
    _txt(bh_aft, "outerradius", f"{coupler_or:.6f}")

    # Avionics mass inside coupler
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

    # ── Aft Section (fins, drogue, motor) ────────────────────────────────────
    # NOT a "fin can" bodytube — it IS the aft outer airframe section.
    # Fins and motor innertube are siblings here, both at ao:bottom=0.
    aft    = _sub(sc, "bodytube")
    _txt(aft, "name", "Aft Section")
    _txt(aft, "id", _uid())
    _txt(aft, "finish", "normal")
    _material(aft)
    _txt(aft, "length", f"{aft_len_m:.4f}")
    _txt(aft, "thickness", f"{wall_m:.4f}")
    _txt(aft, "radius", f"{tube_r:.6f}")
    aft_sc = _sub(aft, "subcomponents")

    # Drogue — near top of aft section, between coupler extension and motor
    if dual:
        drogue = _sub(aft_sc, "parachute")
        _txt(drogue, "name", "Drogue")
        _txt(drogue, "id", _uid())
        # Position below the coupler extension (which occupies the first coupler_ext_m)
        drogue_offset_m = coupler_ext_m + 0.025   # 25mm below coupler end
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

    # Fins — at aft end of aft section (ao:bottom=0)
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

    # Motor innertube — at aft end of aft section (ao:bottom=0)
    # Min-diameter: use air material (zero density) — motor tube IS the airframe.
    inner = _sub(aft_sc, "innertube")
    _txt(inner, "name", "Motor Mount")
    _txt(inner, "id", _uid())
    _place(inner, "bottom", "0.0")
    if min_diameter:
        el = ET.SubElement(inner, "material")
        el.set("type", "bulk"); el.set("density", "0.0"); el.text = "air"
        _txt(inner, "thickness", f"{0.001 * IN_TO_M:.6f}")   # nominal 1 thou wall
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

    # Centering rings + engine block inside motor tube (non-min-diameter only)
    if not min_diameter:
        # Aft centering ring — just past motor tube aft end (holds motor against nozzle)
        cr_aft = _sub(inner_sc, "centeringring")
        _txt(cr_aft, "name", "Aft Centering Ring")
        _txt(cr_aft, "id", _uid())
        _place(cr_aft, "bottom", f"{CR_THICK_M:.4f}")   # just past aft end
        _material(cr_aft)
        _txt(cr_aft, "length", f"{CR_THICK_M:.4f}")
        _txt(cr_aft, "radialposition", "0.0")
        _txt(cr_aft, "radialdirection", "0.0")
        _txt(cr_aft, "outerradius", "auto")
        _txt(cr_aft, "innerradius", f"{motor_or:.6f}")

        # Forward centering ring — 50mm from motor tube forward end
        fwd_cr_ao = -(motor_len_m - 0.05)
        cr_fwd = _sub(inner_sc, "centeringring")
        _txt(cr_fwd, "name", "Forward Centering Ring")
        _txt(cr_fwd, "id", _uid())
        _place(cr_fwd, "bottom", f"{fwd_cr_ao:.4f}")
        _material(cr_fwd)
        _txt(cr_fwd, "length", f"{CR_THICK_M:.4f}")
        _txt(cr_fwd, "radialposition", "0.0")
        _txt(cr_fwd, "radialdirection", "0.0")
        _txt(cr_fwd, "outerradius", "auto")
        _txt(cr_fwd, "innerradius", f"{motor_or:.6f}")

        # Engine block (thrust plate) — at aft end of motor tube
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

    # Motormount + motor configuration
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

    # ── ZIP output (.ork = ZIP containing rocket.ork XML) ─────────────────────
    xml_str = "<?xml version='1.0' encoding='utf-8'?>\n"
    xml_str += ET.tostring(root, encoding="unicode")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("rocket.ork", xml_str.encode("utf-8"))
    return buf.getvalue()


# ── Test inputs ────────────────────────────────────────────────────────────────
# Motor: Loki M1378LR — most powerful available 54mm (ThrustCurve, 2026-05-10)
# 5363 Ns, 1108mm long, Loki 54/4000 case
design = {
    "tube_od_in":   2.26,
    "wall_in":      0.065,
    "nose_shape":   "ogive",
    "nose_length_in": 7.0,
    "fwd_bay_length_in": 20.0,
    "avionics_bay_length_in": 9.0,   # ebay coupler length
    "avionics_mass_kg": 0.15,
    "fin_count": 4,
    "fin_root_in": 7.0,
    "fin_tip_in":  2.5,
    "fin_span_in": 5.5,
    "fin_sweep_in": 3.0,
    "fin_thickness_in": 0.125,
    "motor_designation": "M1378LR",
    "motor_manufacturer": "Loki",
    "motor_od_in":    54 / 25.4,     # 2.1260"
    "motor_length_in": 1108 / 25.4,  # 43.62"
    "drogue_dia_in": 18.0,
    "main_dia_in":   60.0,
}
config = {
    "recovery": "dual",
    "main_deploy_ft": 700,
    "drogue_deploy": "apogee",
}

ork_bytes = generate_ork(design, config)

buf = io.BytesIO(ork_bytes)
with zipfile.ZipFile(buf, "r") as zf:
    xml_content = zf.read("rocket.ork").decode()

# ── Structural assertions ──────────────────────────────────────────────────────
assert "<openrocket" in xml_content
assert 'version="1.9"' in xml_content

# Two bodytubes + switch band (NOT three bodytubes)
assert "Forward Section" in xml_content
assert "Avionics Switch Band" in xml_content
assert "Aft Section" in xml_content
assert "Avionics Bay" not in xml_content     # old wrong middle section name
assert "Fin Can" not in xml_content           # fin can must NOT be a bodytube

# Ebay coupler (not a bodytube)
assert "tubecoupler" in xml_content
assert "Avionics Ebay" in xml_content
assert "Fwd Bulkhead" in xml_content
assert "Aft Bulkhead" in xml_content
assert "masscomponent" in xml_content        # avionics mass inside coupler

# Motor mount — innertube with motormount
assert "innertube" in xml_content
assert "motormount" in xml_content
assert "M1378LR" in xml_content

# Parachutes in correct locations, lowercase deploy events
assert "apogee" in xml_content              # drogue: lowercase
assert "altitude" in xml_content            # main: lowercase
assert "ALTITUDE" not in xml_content
assert "APOGEE" not in xml_content

# Element name correctness
assert "<radius>" in xml_content            # bodytube outer radius (not outerdiameter)
assert "aftradius" in xml_content           # nosecone aftradius

# Min-diameter check: air innertube (motor IS the airframe)
tube_id  = design["tube_od_in"] - 2 * design["wall_in"]
motor_od = design["motor_od_in"]
clearance_mm = (tube_id - motor_od) * 25.4
print(f"Tube ID: {tube_id:.3f}\"  Motor OD: {motor_od:.3f}\"  Clearance: {clearance_mm:.2f}mm → MIN DIAMETER")
assert ">air<" in xml_content               # air material for zero-mass motor tube
assert "centeringring" not in xml_content   # no centering rings in min-diam

# Single-deploy variant
config_single = {"recovery": "single", "main_deploy_ft": 700}
b_single = generate_ork(design, config_single)
xml_single = zipfile.ZipFile(io.BytesIO(b_single)).read("rocket.ork").decode()
assert "ejection" in xml_single
assert "apogee" not in xml_single
assert xml_single.count("<parachute>") == 1

# Non-min-diam variant (3" / 76mm tube, 38mm motor)
design_std = dict(design)
design_std.update({
    "tube_od_in": 3.0,
    "wall_in": 0.082,
    "motor_od_in": 38 / 25.4,  # 38mm motor
    "motor_length_in": 12.0,
    "nose_length_in": 9.0,
    "fwd_bay_length_in": 18.0,
    "drogue_dia_in": 12.0,
    "main_dia_in": 48.0,
})
b_std = generate_ork(design_std, config)
xml_std = zipfile.ZipFile(io.BytesIO(b_std)).read("rocket.ork").decode()
assert "centeringring" in xml_std
assert "engineblock" in xml_std
assert ">air<" not in xml_std              # real material in non-min-diam motor tube

print("All assertions PASS")

# Write output for manual inspection in OpenRocket
out_path = "/tmp/test_design.ork"
with open(out_path, "wb") as f:
    f.write(ork_bytes)
print(f"Written: {out_path}  ({len(ork_bytes)} bytes, ZIP)")

# Compute section lengths for sanity check
switch_band = SWITCH_BAND_LEN_M
ebay_len    = design["avionics_bay_length_in"] * IN_TO_M
coupler_ext = (ebay_len - switch_band) / 2
aft_len     = coupler_ext + DROGUE_SPACE_M + design["motor_length_in"] * IN_TO_M + NOZZLE_OVERHANG_M
total_len   = design["nose_length_in"] * IN_TO_M + design["fwd_bay_length_in"] * IN_TO_M + switch_band + aft_len
print(f"\nSection lengths:")
print(f"  Nose:         {design['nose_length_in']:.1f}\"")
print(f"  Fwd Section:  {design['fwd_bay_length_in']:.1f}\"")
print(f"  Switch Band:  {switch_band / IN_TO_M:.1f}\"  (coupler: {design['avionics_bay_length_in']:.1f}\" centered)")
print(f"  Aft Section:  {aft_len / IN_TO_M:.1f}\"  (coupler ext {coupler_ext/IN_TO_M:.1f}\" + 6\" space + motor {design['motor_length_in']:.1f}\" + 1\" nozzle)")
print(f"  Total:        {total_len / IN_TO_M:.1f}\"")

print("\n--- XML (rocket.ork) ---")
import xml.dom.minidom
print(xml.dom.minidom.parseString(xml_content).toprettyxml(indent="  "))
