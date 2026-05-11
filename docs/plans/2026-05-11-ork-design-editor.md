# ORK Design Editor Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add an "Editor" sub-mode to the Design tab where users open an existing `.ork` file, see a visual component tree, edit component properties (dimensions, materials, masses, fins, parachutes), and save the modified `.ork` back to disk.

**Architecture:** Two new backend endpoints: `POST /api/design/parse-ork` (zip → XML → structured JSON) and `POST /api/design/write-ork` (structured JSON → XML → zip). Frontend adds a toggle in the Design tab between existing "Chat" mode (Gemini assistant) and new "Editor" mode (visual component editor). The editor mode has a left sidebar component tree, a center 2D side-profile canvas, and a right property panel that changes based on selected component.

**Tech Stack:** React 19, TypeScript, Tailwind, FastAPI, Python 3.11, xml.etree.ElementTree, zipfile. No new dependencies.

---

## Component Schema (from ORK XML analysis)

Editable component types and their key properties:

| Type | Key Properties |
|---|---|
| `nosecone` | name, shape, length, thickness, aftradius, aftshoulder*, overridemass, material |
| `bodytube` | name, length, thickness, radius, overridemass, material |
| `tubecoupler` | name, length, outerradius, overridemass, material |
| `innertube` | name, length, outerradius, thickness, overridemass, material |
| `trapezoidfinset` | name, fincount, rootchord, tipchord, sweep, span, thickness, cant, crosssection, filletradius, position |
| `freeformfinset` | name, fincount, thickness, cant, finpoints, position |
| `parachute` | name, diameter, cd, deployevent, deployaltitude, linecount, linelength, overridemass |
| `shockcord` | name, cordlength, overridemass |
| `masscomponent` | name, mass, packedlength, packedradius |
| `bulkhead` | name, length, outerradius, overridemass, material |
| `centeringring` | name, length, outerradius, innerradius, overridemass, material |
| `engineblock` | name, length, outerradius, innerradius, overridemass, material |
| `railbutton` | name, outerdiameter, innerdiameter, height |

Common fields on every component: `id`, `name`, `axialoffset {method, value}`, `overridemass`, `overridesubcomponentsmass`, `material {type, density, name}`, `comment`

---

## Tasks

### Task 1: Backend — ORK Parser Endpoint

**Objective:** Parse `.ork` file (ZIP/gzip/plain) into a structured JSON component tree.

**Files:**
- Create: `backend/ork_editor.py`
- Modify: `backend/main.py` (add route)

**Step 1: Create `ork_editor.py` with `parse_ork_to_tree(ork_bytes: bytes) -> dict`**

```python
"""
ORK Design Editor: parse .ork files into editable JSON trees and write them back.
"""
import base64
import io
import zipfile
import xml.etree.ElementTree as ET
from typing import Any

# Component types we parse into the tree
COMPONENT_TAGS = {
    "nosecone", "bodytube", "tubecoupler", "innertube",
    "trapezoidfinset", "freeformfinset", "parachute", "shockcord",
    "masscomponent", "bulkhead", "centeringring", "engineblock",
    "railbutton",
}

# Properties to extract per component type (tag name -> list of child tag names)
COMPONENT_PROPS: dict[str, list[str]] = {
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


def _parse_material(elem: ET.Element) -> dict | None:
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
            comp[prop] = val == "true" if val in ("true", "false") else float(el.text.strip())

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
```

**Step 2: Add `POST /api/design/parse-ork` route to `main.py`**

Add after the existing design routes:

```python
from ork_editor import parse_ork_to_tree

@app.post("/api/design/parse-ork")
async def parse_ork_endpoint(file: UploadFile):
    if not file.filename or not file.filename.endswith(".ork"):
        raise HTTPException(status_code=400, detail="File must be .ork")
    ork_bytes = await file.read()
    try:
        tree = await asyncio.to_thread(parse_ork_to_tree, ork_bytes)
        return tree
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Failed to parse .ork: {e}")
```

**Step 3: Test with curl**

```bash
cd backend && curl -F "file=@../rev19.ork" http://localhost:8080/api/design/parse-ork | python3.11 -m json.tool | head -60
```

Expected: JSON with rocket_name, components array containing nosecone, bodytube, etc.

**Step 4: Commit**

```bash
git add backend/ork_editor.py backend/main.py
git commit -m "feat: add /api/design/parse-ork endpoint for ORK component tree extraction"
```

---

### Task 2: Backend — ORK Writer Endpoint

**Objective:** Write a modified component tree back to a valid `.ork` file.

**Files:**
- Modify: `backend/ork_editor.py` (add `write_tree_to_ork`)
- Modify: `backend/main.py` (add route)

**Step 1: Add `write_tree_to_ork(tree: dict, original_ork_bytes: bytes | None = None) -> bytes`**

The writer needs the original `.ork` bytes to preserve simulation data, motor thrust curves, and other non-editable sections. Strategy: parse original XML → find each component by `id` → update its editable fields → re-serialize.

```python
import copy

def write_tree_to_ork(tree: dict, original_ork_bytes: bytes) -> bytes:
    """Apply edited component properties back to the original .ork XML.
    
    Strategy: parse original XML, walk the component tree, update fields
    that changed, then re-zip the result. This preserves simulation data,
    motor configs, and other non-editable sections.
    """
    xml_str = _extract_ork_xml(original_ork_bytes)
    root = ET.fromstring(xml_str)
    
    # Build a lookup: component id -> edited component dict
    edits: dict[str, dict] = {}
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


def _collect_edits(components: list[dict], edits: dict[str, dict]) -> None:
    """Flatten the component tree into an id->edit_dict lookup."""
    for comp in components:
        comp_id = comp.get("id", "")
        if comp_id:
            edits[comp_id] = comp
        for child in comp.get("children", []):
            if child.get("type") != "motormount":
                _collect_edits([child], edits)


def _set_text(elem: ET.Element, tag: str, value: Any) -> None:
    """Set child element text, creating if needed."""
    child = elem.find(tag)
    if child is None:
        child = ET.SubElement(elem, tag)
    child.text = str(value)


def _apply_edits_to_xml(parent: ET.Element, edits: dict[str, dict]) -> None:
    """Recursively apply edits to XML elements matched by <id>."""
    for elem in parent:
        tag = elem.tag.lower()
        
        if tag == "subcomponents":
            _apply_edits_to_xml(elem, edits)
            continue
        
        # Check if this element has an <id> that matches an edit
        id_el = elem.find("id")
        if id_el is not None and id_el.text:
            comp_id = id_el.text.strip()
            if comp_id in edits:
                edit = edits[comp_id]
                _apply_component_edits(elem, edit)
        
        # Recurse into children
        _apply_edits_to_xml(elem, edits)


EDITABLE_PER_TYPE: dict[str, list[str]] = {
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


def _apply_component_edits(elem: ET.Element, edit: dict) -> None:
    """Apply edited fields to an XML element."""
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
    
    # Update common editable fields
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
```

**Step 2: Add `POST /api/design/write-ork` route to `main.py`**

```python
@app.post("/api/design/write-ork")
async def write_ork_endpoint(request: Request):
    body = await request.json()
    tree = body.get("tree")
    ork_b64 = body.get("ork_b64")  # base64 of original .ork
    if not tree or not ork_b64:
        raise HTTPException(status_code=400, detail="tree and ork_b64 required")
    original_bytes = base64.b64decode(ork_b64)
    try:
        new_ork_bytes = await asyncio.to_thread(write_tree_to_ork, tree, original_bytes)
        return {"ork_b64": base64.b64encode(new_ork_bytes).decode("ascii")}
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Failed to write .ork: {e}")
```

**Step 3: Test roundtrip**

```bash
# Parse → write → parse again, compare
cd backend && python3.11 -c "
from ork_editor import parse_ork_to_tree, write_tree_to_ork
with open('../rev19.ork', 'rb') as f:
    data = f.read()
tree = parse_ork_to_tree(data)
new_ork = write_tree_to_ork(tree, data)
tree2 = parse_ork_to_tree(new_ork)
print('Components match:', len(tree['components']) == len(tree2['components']))
print('Rocket name:', tree2['rocket_name'])
# Print first few components
for stage in tree2['components'][:1]:
    for c in stage.get('children', [])[:3]:
        print(f'  {c[\"type\"]}: {c[\"name\"]}')
"
```

**Step 4: Commit**

```bash
git add backend/ork_editor.py backend/main.py
git commit -m "feat: add /api/design/write-ork endpoint for ORK roundtrip editing"
```

---

### Task 3: Frontend — Editor Mode UI (Component Tree + Property Panel)

**Objective:** Add "Editor" sub-mode to DesignPage with component tree sidebar and property panel.

**Files:**
- Modify: `frontend/src/pages/DesignPage.tsx`

**Step 1: Add Editor state and mode toggle to DesignPage.tsx**

Add these interfaces and state:

```typescript
interface OrkComponent {
  type: string;
  id: string;
  name: string;
  children?: OrkComponent[];
  [key: string]: any;  // dynamic properties
}

interface OrkTree {
  rocket_name: string;
  designer: string;
  version: string;
  creator: string;
  components: OrkComponent[];  // stages
}
```

Add state:
```typescript
const [mode, setMode] = useState<'chat' | 'editor'>('chat');
const [orkTree, setOrkTree] = useState<OrkTree | null>(null);
const [selectedId, setSelectedId] = useState<string | null>(null);
const [originalOrkB64, setOriginalOrkB64] = useState<string | null>(null);
const [editorFile, setEditorFile] = useState<File | null>(null);
```

Add mode toggle buttons at the top of the Design page layout.

**Step 2: Add file upload for Editor mode**

When mode === 'editor', show a file upload zone. On file select:
1. Read file as base64 → store in `originalOrkB64`
2. POST to `/api/design/parse-ork` → store in `orkTree`
3. Auto-select first component

**Step 3: Build component tree sidebar**

Recursive component that renders each component as a clickable row with indent based on depth:
- Stage items are expandable/collapsible
- Each component shows an icon (🔶 nosecone, ▮ bodytube, △ fins, 🪂 parachute, ● mass)
- Selected component highlighted with blue border

**Step 4: Build property editor panel**

Right panel that renders based on `selectedId`. Find the selected component in `orkTree` by id. Render field editors based on component type:

- **Number fields:** `<input type="number">` with step/precision appropriate to field
- **Material:** display name + density (read-only for v1)
- **Position:** show method dropdown + offset value
- **Override mass:** checkbox + value input

Group fields into sections: Dimensions, Material, Mass/CG Override, Position.

**Step 5: Wire up edits**

On any field change, deep-clone `orkTree`, update the specific field on the selected component, set `orkTree` to the clone. This gives us live editing.

**Step 6: Add Save button**

On Save click:
1. POST tree + originalOrkB64 to `/api/design/write-ork`
2. Get back new ork_b64
3. Trigger browser download of the new .ork file
4. Also update originalOrkB64 so further edits are incremental

**Step 7: Commit**

```bash
git add frontend/src/pages/DesignPage.tsx
git commit -m "feat: add Editor mode to Design tab with component tree and property panel"
```

---

### Task 4: Frontend — 2D Side Profile Canvas

**Objective:** Render a 2D side-profile view of the rocket that highlights the selected component.

**Files:**
- Modify: `frontend/src/pages/DesignPage.tsx` (add canvas element + drawing function)

**Step 1: Add canvas rendering function**

Using HTML5 Canvas API (no new deps), draw:
- Each bodytube as a rectangle (width = length, height = 2×radius)
- Nosecone as a triangle/curve depending on shape
- Fins as triangles at their axial position
- Selected component highlighted in blue, rest in gray

Layout is nose-left, tail-right. Scale to fit canvas width with padding.

**Step 2: Update on selection change**

Redraw when `selectedId` or `orkTree` changes. Compute cumulative x position from component tree order.

**Step 3: Commit**

```bash
git add frontend/src/pages/DesignPage.tsx
git commit -m "feat: add 2D rocket side-profile canvas to Design Editor"
```

---

### Task 5: Integration — "Load into Simulator" Button

**Objective:** Allow saving edited .ork and immediately loading it into the Simulation tab.

**Files:**
- Modify: `frontend/src/pages/DesignPage.tsx`

**Step 1: Add "Simulate" button**

After saving, offer a "Simulate Now" button that:
1. Decodes the returned ork_b64 to bytes
2. Creates a `File` object
3. Calls `setSelectedFile(file)` and `setActivePage('main')`

This reuses the existing flow from the chat-based design builder.

**Step 2: Commit**

```bash
git add frontend/src/pages/DesignPage.tsx
git commit -m "feat: add Simulate Now button to Design Editor for quick sim handoff"
```