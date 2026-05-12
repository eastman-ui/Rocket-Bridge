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
                mm_data: dict = {"type": "motormount", "id": comp["id"] + "_mm", "name": "Motor Mount"}
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


# ─── Writer: apply edited component tree back to original .ork XML ───────────

# Properties that are editable per component type (for writing back)
EDITABLE_PER_TYPE: Dict[str, List[str]] = {
    "nosecone": ["shape", "length", "thickness", "aftradius",
                 "aftshoulderradius", "aftshoulderlength", "aftshoulderthickness",
                 "aftshouldercapped", "isflipped", "shapeclipped", "shapeparameter"],
    "bodytube": ["length", "thickness", "radius"],
    "tubecoupler": ["length", "outerradius"],
    "innertube": ["length", "outerradius", "thickness"],
    "trapezoidfinset": ["rootchord", "tipchord", "sweep", "span",
                        "thickness", "cant", "crosssection", "filletradius", "fincount"],
    "freeformfinset": ["thickness", "cant", "fincount"],
    "parachute": ["diameter", "cd", "deployaltitude", "deploydelay", "linecount", "linelength"],
    "shockcord": ["cordlength"],
    "masscomponent": ["mass", "packedlength", "packedradius"],
    "bulkhead": ["length", "outerradius"],
    "centeringring": ["length", "outerradius", "innerradius"],
    "engineblock": ["length", "outerradius", "innerradius"],
    "railbutton": ["outerdiameter", "innerdiameter", "height"],
}

COMMON_EDITABLE = ["overridemass", "name"]


def _set_text(elem: ET.Element, tag: str, value: Any) -> None:
    """Set child element text, creating the element if needed."""
    child = elem.find(tag)
    if child is None:
        child = ET.SubElement(elem, tag)
    child.text = str(value)


def _collect_edits(components: list, edits: Dict[str, dict]) -> None:
    """Flatten the component tree into an id -> edit_dict lookup."""
    for comp in components:
        comp_id = comp.get("id", "")
        if comp_id:
            edits[comp_id] = comp
        for child in comp.get("children", []):
            _collect_edits([child], edits)


def _apply_component_edits(elem: ET.Element, edit: dict) -> None:
    """Apply edited fields from the JSON tree to an XML element."""
    comp_type = elem.tag.lower()

    # Update name
    if "name" in edit:
        name_el = elem.find("name")
        if name_el is not None:
            name_el.text = edit["name"]

    # Update comment
    if "comment" in edit:
        comment_el = elem.find("comment")
        if comment_el is not None:
            comment_el.text = edit["comment"] or ""

    # Update common editable fields (skip "name" — handled above)
    for prop in COMMON_EDITABLE:
        if prop in edit and prop != "name":
            _set_text(elem, prop, edit[prop])

    # Update type-specific fields
    for prop in EDITABLE_PER_TYPE.get(comp_type, []):
        if prop in edit:
            _set_text(elem, prop, edit[prop])

    # Update position
    if "position" in edit:
        pos = edit["position"]
        ao = elem.find("axialoffset")
        if ao is not None:
            ao.set("method", pos.get("method", "top"))
            ao.text = str(pos.get("offset", 0.0))
        pos_el = elem.find("position")
        if pos_el is not None:
            pos_el.set("type", pos.get("position_type", "top"))
            pos_el.text = str(pos.get("position_value", 0.0))

    # Update material
    if "material" in edit and edit["material"]:
        mat_el = elem.find("material")
        if mat_el is not None:
            mat = edit["material"]
            mat_el.text = mat.get("name", "")
            mat_el.set("type", mat.get("type", "bulk"))
            mat_el.set("density", str(mat.get("density", 0)))

    # Special: freeform fin points
    if comp_type == "freeformfinset" and "finpoints" in edit:
        fp_el = elem.find("finpoints")
        if fp_el is not None:
            # Remove existing points
            for pt in fp_el.findall("point"):
                fp_el.remove(pt)
            # Add new points
            for pt in edit["finpoints"]:
                pt_el = ET.SubElement(fp_el, "point")
                pt_el.set("x", str(pt.get("x", 0)))
                pt_el.set("y", str(pt.get("y", 0)))

    # Update color
    if "color" in edit:
        color_el = elem.find("color")
        if color_el is not None:
            for k in ("red", "green", "blue", "alpha"):
                if k in edit["color"]:
                    color_el.set(k, str(edit["color"][k]))


def _apply_motor_edits(mm_elem: ET.Element, edit: dict) -> None:
    """Write motor selection edits into a MotorMount XML element."""
    motor = edit.get("motor")
    if not motor:
        return
    motor_el = mm_elem.find("motor")
    if motor_el is None:
        motor_el = ET.SubElement(mm_elem, "motor")
    for field in ("designation", "manufacturer", "type", "digest"):
        if motor.get(field) is not None:
            _set_text(motor_el, field, motor[field])
    for field in ("diameter", "length", "delay"):
        if motor.get(field) is not None:
            _set_text(motor_el, field, str(motor[field]))


def _apply_edits_to_xml(parent: ET.Element, edits: Dict[str, dict]) -> None:
    """Recursively apply edits to XML elements matched by <id>."""
    for elem in parent:
        tag = elem.tag.lower()

        if tag == "subcomponents":
            _apply_edits_to_xml(elem, edits)
            continue

        # Check if this element has an <id> matching an edit
        id_el = elem.find("id")
        if id_el is not None and id_el.text:
            comp_id = id_el.text.strip()
            if comp_id in edits:
                _apply_component_edits(elem, edits[comp_id])

            # Also update MotorMount inside this element's subcomponents
            mm_key = comp_id + "_mm"
            if mm_key in edits:
                subs = elem.find("subcomponents")
                if subs is not None:
                    for sub_child in subs:
                        if sub_child.tag.lower() == "motormount":
                            _apply_motor_edits(sub_child, edits[mm_key])
                            break

        # Recurse into children
        _apply_edits_to_xml(elem, edits)


def write_tree_to_ork(tree: dict, original_ork_bytes: bytes) -> bytes:
    """Apply edited component properties back to the original .ork XML.

    Strategy: parse original XML, walk the component tree, update fields
    that changed, then re-serialize. This preserves simulation data,
    motor configs, and other non-editable sections.
    """
    xml_str = _extract_ork_xml(original_ork_bytes)
    root = ET.fromstring(xml_str)

    # Build a lookup: component id -> edited component dict
    edits: Dict[str, dict] = {}
    _collect_edits(tree.get("components", []), edits)

    # Walk the original XML tree and apply edits
    rocket = root.find("rocket")
    if rocket is not None:
        _apply_edits_to_xml(rocket, edits)

    # Serialize back to XML
    ET.indent(root, space="  ")
    xml_out = ET.tostring(root, encoding="unicode", xml_declaration=True)

    # Re-zip if original was ZIP
    magic = original_ork_bytes[:4]
    if magic[:2] == b"PK":
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("rocket.ork", xml_out)
        return buf.getvalue()
    else:
        return xml_out.encode("utf-8")


# ─── Component add / remove ───────────────────────────────────────────────────

# Map lowercase type names to correct OpenRocket XML tag names
_TYPE_TO_TAG: Dict[str, str] = {
    "nosecone": "NoseCone",
    "bodytube": "BodyTube",
    "tubecoupler": "TubeCoupler",
    "innertube": "InnerTube",
    "trapezoidfinset": "TrapezoidFinSet",
    "freeformfinset": "FreeformFinSet",
    "parachute": "Parachute",
    "shockcord": "ShockCord",
    "masscomponent": "MassComponent",
    "bulkhead": "Bulkhead",
    "centeringring": "CenteringRing",
    "engineblock": "EngineBlock",
    "railbutton": "RailButton",
}


def _component_to_xml(comp: dict) -> ET.Element:
    """Serialize a component dict to an XML element for insertion into the ORK tree."""
    import uuid as _uuid
    comp_type = comp.get("type", "")
    tag = _TYPE_TO_TAG.get(comp_type, comp_type)
    elem = ET.Element(tag)

    _set_text(elem, "name", comp.get("name", "Component"))
    _set_text(elem, "id", comp.get("id") or str(_uuid.uuid4()))
    if comp.get("comment"):
        _set_text(elem, "comment", comp["comment"])

    # Axial position
    pos = comp.get("position", {})
    ao = ET.SubElement(elem, "axialoffset")
    ao.set("method", pos.get("method", "top"))
    ao.text = str(pos.get("offset", 0.0))
    pos_el = ET.SubElement(elem, "position")
    pos_el.set("type", pos.get("position_type", "top"))
    pos_el.text = str(pos.get("position_value", 0.0))

    # Type-specific numeric/string properties
    for prop in EDITABLE_PER_TYPE.get(comp_type, []):
        if prop in comp:
            _set_text(elem, prop, str(comp[prop]))

    # Common overrides
    for prop in COMMON_EDITABLE:
        if prop in comp and prop != "name":
            _set_text(elem, prop, str(comp[prop]))

    # Freeform fin points
    if comp_type == "freeformfinset" and comp.get("finpoints"):
        fp_el = ET.SubElement(elem, "finpoints")
        for pt in comp["finpoints"]:
            pt_el = ET.SubElement(fp_el, "point")
            pt_el.set("x", str(pt.get("x", 0)))
            pt_el.set("y", str(pt.get("y", 0)))

    # Material
    mat = comp.get("material")
    if mat:
        mat_el = ET.SubElement(elem, "material")
        mat_el.set("type", mat.get("type", "bulk"))
        mat_el.set("density", str(mat.get("density", 0)))
        mat_el.text = mat.get("name", "")

    ET.SubElement(elem, "subcomponents")
    return elem


def _find_by_id(parent: ET.Element, target_id: str) -> Optional[ET.Element]:
    """Return the first element whose <id> child matches target_id."""
    id_el = parent.find("id")
    if id_el is not None and id_el.text and id_el.text.strip() == target_id:
        return parent
    for child in parent:
        found = _find_by_id(child, target_id)
        if found is not None:
            return found
    return None


def _serialize_ork(root: ET.Element, original_ork_bytes: bytes) -> bytes:
    """Serialize an XML root back to ORK bytes (ZIP or plain)."""
    ET.indent(root, space="  ")
    xml_out = ET.tostring(root, encoding="unicode", xml_declaration=True)
    if original_ork_bytes[:2] == b"PK":
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("rocket.ork", xml_out)
        return buf.getvalue()
    return xml_out.encode("utf-8")


def add_component_to_ork(parent_id: str, new_comp: dict, original_ork_bytes: bytes) -> bytes:
    """Insert a new component as a child of the element with id=parent_id."""
    xml_str = _extract_ork_xml(original_ork_bytes)
    root = ET.fromstring(xml_str)

    parent_elem = _find_by_id(root, parent_id)
    if parent_elem is None:
        raise ValueError(f"Parent component '{parent_id}' not found in ORK file")

    subs = parent_elem.find("subcomponents")
    if subs is None:
        subs = ET.SubElement(parent_elem, "subcomponents")

    subs.append(_component_to_xml(new_comp))
    return _serialize_ork(root, original_ork_bytes)


def remove_component_from_ork(comp_id: str, original_ork_bytes: bytes) -> bytes:
    """Remove the component with id=comp_id from the ORK tree."""
    xml_str = _extract_ork_xml(original_ork_bytes)
    root = ET.fromstring(xml_str)

    def _remove(parent: ET.Element) -> bool:
        for child in list(parent):
            id_el = child.find("id")
            if id_el is not None and id_el.text and id_el.text.strip() == comp_id:
                parent.remove(child)
                return True
            if _remove(child):
                return True
        return False

    _remove(root)
    return _serialize_ork(root, original_ork_bytes)