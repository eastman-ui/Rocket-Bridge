"""
ORK Design Editor: parse .ork files into editable JSON trees and write them back.
"""
import io
import zipfile
import xml.etree.ElementTree as ET
from typing import Any, Dict, List, Optional

# Component types we parse into the tree
COMPONENT_TAGS = {
    "nosecone", "bodytube", "tubecoupler", "innertube",
    "trapezoidfinset", "freeformfinset", "parachute", "shockcord",
    "masscomponent", "bulkhead", "centeringring", "engineblock",
    "railbutton",
}

# Properties to extract per component type (tag name -> list of child tag names)
COMPONENT_PROPS: Dict[str, List[str]] = {
    "nosecone": ["shape", "shapeclipped", "shapeparameter", "length", "thickness",
                 "aftradius", "aftshoulderradius", "aftshoulderlength",
                 "aftshoulderthickness", "aftshouldercapped", "isflipped"],
    "bodytube": ["length", "thickness", "radius"],
    "tubecoupler": ["length", "outerradius"],
    "innertube": ["length", "outerradius", "thickness",
                  "clusterconfiguration", "clusterscale", "clusterrotation"],
    "trapezoidfinset": ["fincount", "rootchord", "tipchord", "sweep", "span",
                        "thickness", "cant", "crosssection", "filletradius"],
    "freeformfinset": ["fincount", "thickness", "cant", "crosssection"],
    "parachute": ["diameter", "cd", "deployevent", "deployaltitude", "deploydelay",
                  "linecount", "linelength"],
    "shockcord": ["cordlength"],
    "masscomponent": ["mass", "masscomponenttype", "packedlength", "packedradius"],
    "bulkhead": ["length", "outerradius"],
    "centeringring": ["length", "outerradius", "innerradius"],
    "engineblock": ["length", "outerradius", "innerradius"],
    "railbutton": ["outerdiameter", "innerdiameter", "height", "baseheight", "flangeheight", "screwheight"],
}

# Properties present on ALL components
COMMON_PROPS = ["overridemass", "overridesubcomponentsmass", "finish"]


def _extract_ork_xml(ork_bytes: bytes) -> str:
    """Extract XML string from .ork bytes (ZIP, gzip, or plain XML)."""
    magic = ork_bytes[:4]
    if magic[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(ork_bytes)) as zf:
            names = zf.namelist()
            entry = next((n for n in names if n.endswith(".ork") or n.endswith(".xml")), names[0])
            return zf.read(entry).decode("utf-8", errors="replace")
    elif magic[:2] == b"\x1f\x8b":
        import gzip
        with gzip.open(io.BytesIO(ork_bytes), "rt", encoding="utf-8", errors="replace") as f:
            return f.read()
    else:
        return ork_bytes.decode("utf-8", errors="replace")


def _parse_material(elem: ET.Element) -> Optional[dict]:
    """Parse <material type="..." density="...">Name</material>."""
    mat_el = elem.find("material")
    if mat_el is None:
        return None
    return {
        "name": (mat_el.text or "").strip(),
        "type": mat_el.get("type", "bulk"),
        "density": float(mat_el.get("density", "0")),
    }


def _parse_position(elem: ET.Element) -> dict:
    """Parse axialoffset + position pair."""
    ao = elem.find("axialoffset")
    pos = elem.find("position")
    return {
        "method": ao.get("method", "top") if ao is not None else "top",
        "offset": float(ao.text or "0") if ao is not None else 0.0,
        "position_type": pos.get("type", "top") if pos is not None else "top",
        "position_value": float(pos.text or "0") if pos is not None else 0.0,
    }


def _parse_component(elem: ET.Element) -> dict:
    """Parse a single ORK component element into a dict."""
    tag = elem.tag.lower()
    comp: dict[str, Any] = {
        "type": tag,
        "id": (elem.findtext("id") or "").strip(),
        "name": (elem.findtext("name") or "").strip(),
        "comment": (elem.findtext("comment") or "").strip() or None,
        "position": _parse_position(elem),
        "material": _parse_material(elem),
    }

    # Common props
    for prop in COMMON_PROPS:
        el = elem.find(prop)
        if el is not None and el.text is not None:
            val = el.text.strip().lower()
            if val in ("true", "false"):
                comp[prop] = val == "true"
            else:
                try:
                    comp[prop] = float(val)
                except ValueError:
                    comp[prop] = el.text.strip()

    # Type-specific props
    for prop in COMPONENT_PROPS.get(tag, []):
        el = elem.find(prop)
        if el is not None and el.text is not None:
            try:
                comp[prop] = float(el.text.strip())
            except ValueError:
                comp[prop] = el.text.strip()

    # Special: freeform fin points
    if tag == "freeformfinset":
        fp_el = elem.find("finpoints")
        if fp_el is not None:
            comp["finpoints"] = [
                {"x": float(p.get("x", "0")), "y": float(p.get("y", "0"))}
                for p in fp_el.findall("point")
            ]

    # Special: color
    color_el = elem.find("color")
    if color_el is not None:
        comp["color"] = {
            "red": color_el.get("red"),
            "green": color_el.get("green"),
            "blue": color_el.get("blue"),
            "alpha": color_el.get("alpha"),
        }

    # Special: override CG
    ovr_cg = elem.find("overridecg")
    if ovr_cg is not None and ovr_cg.text:
        comp["overridecg"] = float(ovr_cg.text.strip())
    ovr_cg_sub = elem.find("overridesubcomponentscg")
    if ovr_cg_sub is not None and ovr_cg_sub.text:
        comp["overridesubcomponentscg"] = ovr_cg_sub.text.strip().lower() == "true"

    # Recurse into subcomponents
    subs_el = elem.find("subcomponents")
    children = []
    if subs_el is not None:
        for child_el in subs_el:
            if child_el.tag.lower() in COMPONENT_TAGS:
                children.append(_parse_component(child_el))
            elif child_el.tag.lower() == "motormount":
                # Parse motor mount wrapper — extract motor info
                mm_data = {"type": "motormount"}
                motor_el = child_el.find("motor")
                if motor_el is not None:
                    mm_data["motor"] = {
                        "designation": (motor_el.findtext("designation") or "").strip(),
                        "manufacturer": (motor_el.findtext("manufacturer") or "").strip(),
                        "diameter": float(motor_el.findtext("diameter") or "0"),
                        "length": float(motor_el.findtext("length") or "0"),
                        "delay": float(motor_el.findtext("delay") or "0"),
                        "digest": (motor_el.findtext("digest") or "").strip(),
                        "type": (motor_el.findtext("type") or "").strip(),
                    }
                children.append(mm_data)

    if children:
        comp["children"] = children

    return comp


def parse_ork_to_tree(ork_bytes: bytes) -> dict:
    """Parse .ork file bytes into a structured component tree JSON.

    Returns: {
        "rocket_name": str,
        "designer": str,
        "version": str,
        "creator": str,
        "components": [...],   # flat list of top-level stage components
    }
    """
    xml_str = _extract_ork_xml(ork_bytes)
    root = ET.fromstring(xml_str)

    rocket = root.find("rocket")
    if rocket is None:
        raise ValueError("No <rocket> element in .ork file")

    result = {
        "rocket_name": (rocket.findtext("name") or "Rocket").strip(),
        "designer": (rocket.findtext("designer") or "").strip(),
        "version": root.get("version", ""),
        "creator": root.get("creator", ""),
        "components": [],
    }

    # Parse stages
    subs = rocket.find("subcomponents")
    if subs is not None:
        for stage_el in subs.findall("stage"):
            stage_name = (stage_el.findtext("name") or "Stage").strip()
            stage_subs = stage_el.find("subcomponents")
            stage_components = []
            if stage_subs is not None:
                for child in stage_subs:
                    if child.tag.lower() in COMPONENT_TAGS:
                        stage_components.append(_parse_component(child))
            result["components"].append({
                "type": "stage",
                "name": stage_name,
                "id": (stage_el.findtext("id") or "").strip(),
                "children": stage_components,
            })

    return result