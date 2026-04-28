import json
import logging
import os
import re
import subprocess
from pathlib import Path
import xml.etree.ElementTree as ET

import numpy as np

logger = logging.getLogger(__name__)


def convert_ork(ork_path: str, output_dir: str) -> dict:
    """
    Convert .ork file to parameters.json via RocketSerializer.

    Args:
        ork_path: Path to the OpenRocket .ork file
        output_dir: Directory where output files (parameters.json, etc.) will be written

    Returns:
        Parsed parameters.json as a dictionary

    Raises:
        FileNotFoundError: If ork_path does not exist
        RuntimeError: If Java 17 is not available or if subprocess fails
    """
    ork_path = str(ork_path)
    output_dir = str(output_dir)

    if not os.path.exists(ork_path):
        raise FileNotFoundError(f"OpenRocket file not found: {ork_path}")

    _check_java_17_available()

    os.makedirs(output_dir, exist_ok=True)

    try:
        cmd = ["ork2json", "--filepath", ork_path, "--output", output_dir]
        jar_path = os.environ.get("OR_JAR_PATH")
        if jar_path:
            cmd += ["--ork_jar", jar_path]
        subprocess.run(cmd, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(
            f"Failed to convert OpenRocket file: {e.stderr or e.stdout or str(e)}"
        )
    except FileNotFoundError:
        raise RuntimeError(
            "ork2json command not found. Install rocketserializer: pip install rocketserializer"
        )

    params_path = os.path.join(output_dir, "parameters.json")
    if not os.path.exists(params_path):
        raise RuntimeError(
            f"RocketSerializer did not produce parameters.json in {output_dir}"
        )

    try:
        with open(params_path, "r") as f:
            params = json.load(f)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Failed to parse parameters.json: {e}")

    # Patch in freeform fins that ork2json can't export
    has_trap = bool(params.get("trapezoidal_fins"))
    has_ell = bool(params.get("elliptical_fins"))
    if not has_trap and not has_ell:
        _inject_freeform_fins(ork_path, params)

    # Fix rocketserializer bugs and extract OR stored data
    _extract_drag_from_ork(ork_path, output_dir, params)
    _fix_motor_dry_mass(ork_path, params)
    _extract_motor_designation(ork_path, params)
    _extract_or_stored_timeseries(ork_path, params)
    _fix_trap_fin_positions_from_ork(ork_path, params)
    _fix_rocket_mass(params)

    return params


def _read_ork_xml(ork_path: str) -> str:
    """Return XML content of .ork file (handles ZIP, gzip, plain)."""
    import gzip, zipfile
    with open(ork_path, "rb") as f:
        magic = f.read(4)
    if magic[:2] == b"PK":
        with zipfile.ZipFile(ork_path) as zf:
            names = zf.namelist()
            entry = next((n for n in names if n.endswith(".ork") or n.endswith(".xml")), names[0])
            return zf.read(entry).decode("utf-8", errors="replace")
    elif magic[:2] == b"\x1f\x8b":
        with gzip.open(ork_path, "rt", encoding="utf-8", errors="replace") as f:
            return f.read()
    else:
        with open(ork_path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()


def _extract_drag_from_ork(ork_path: str, output_dir: str, params: dict) -> None:
    """Fix drag curve: rocketserializer uses 'Axial drag coefficient' (near-zero).
    Correct label is 'Drag coefficient' (~0.6-0.8 for typical rockets).
    """
    try:
        content = _read_ork_xml(ork_path)
        types_match = re.search(r'types="([^"]+)"', content, re.IGNORECASE)
        if not types_match:
            logger.warning("_extract_drag: no types attribute in simulation data")
            return
        types = types_match.group(1).split(",")
        if "Drag coefficient" not in types or "Mach number" not in types:
            logger.warning("_extract_drag: 'Drag coefficient' or 'Mach number' not in data labels")
            return
        idx_cd = types.index("Drag coefficient")
        idx_mach = types.index("Mach number")
        datapoints = re.findall(r"<datapoint>(.*?)</datapoint>", content, re.DOTALL | re.IGNORECASE)
        if not datapoints:
            logger.warning("_extract_drag: no datapoints found")
            return
        mach_vals, cd_vals = [], []
        for dp in datapoints:
            vals = dp.strip().split(",")
            try:
                mach = float(vals[idx_mach])
                cd = float(vals[idx_cd])
                if mach > 0 and cd > 0:
                    mach_vals.append(mach)
                    cd_vals.append(cd)
            except (ValueError, IndexError):
                continue
        if not mach_vals:
            logger.warning("_extract_drag: no valid Mach/CD data points")
            return
        drag_data = np.array([mach_vals, cd_vals]).T
        drag_data = drag_data[drag_data[:, 0].argsort()]
        _, first_idx = np.unique(drag_data[:, 0], return_index=True)
        drag_data = drag_data[first_idx]
        drag_path = os.path.join(output_dir, "drag_curve_fixed.csv")
        np.savetxt(drag_path, drag_data, delimiter=",", fmt="%.6f")
        params["rocket"]["drag_curve"] = drag_path
        logger.info(
            "_extract_drag: %d pts, Mach=[%.3f,%.3f], CD=[%.3f,%.3f]",
            len(drag_data), drag_data[:, 0].min(), drag_data[:, 0].max(),
            drag_data[:, 1].min(), drag_data[:, 1].max(),
        )
    except Exception as exc:
        logger.warning("_extract_drag: failed (%s) — keeping rocketserializer drag_curve", exc)


def _fix_motor_dry_mass(ork_path: str, params: dict) -> None:
    """Extract motor dry mass from .ork simulation data.
    Rocketserializer explicitly zeroes dry_mass; we recover it as min(Motor mass).
    """
    try:
        content = _read_ork_xml(ork_path)
        types_match = re.search(r'types="([^"]+)"', content, re.IGNORECASE)
        if not types_match:
            return
        types = types_match.group(1).split(",")
        if "Motor mass" not in types:
            return
        idx = types.index("Motor mass")
        datapoints = re.findall(r"<datapoint>(.*?)</datapoint>", content, re.DOTALL | re.IGNORECASE)
        masses = []
        for dp in datapoints:
            vals = dp.strip().split(",")
            try:
                masses.append(float(vals[idx]))
            except (ValueError, IndexError):
                continue
        if not masses:
            return
        dry_mass = min(masses)
        if dry_mass > 0.05:
            params["motors"]["dry_mass"] = round(dry_mass, 4)
            logger.info("_fix_motor_dry_mass: dry_mass=%.3f kg", dry_mass)
    except Exception as exc:
        logger.warning("_fix_motor_dry_mass: failed (%s)", exc)


def _inject_freeform_fins(ork_path: str, params: dict) -> None:
    """Parse freeform fins from the .ork XML and add them as trapezoidal approximations."""
    try:
        # .ork files can be: plain XML, gzip-compressed XML, or ZIP archive containing rocket.ork XML
        import gzip, zipfile
        with open(ork_path, "rb") as f:
            magic = f.read(4)

        if magic[:2] == b"PK":
            # ZIP archive — extract the first .ork or .xml entry
            with zipfile.ZipFile(ork_path) as zf:
                names = zf.namelist()
                entry = next((n for n in names if n.endswith(".ork") or n.endswith(".xml")), names[0])
                content = zf.read(entry).decode("utf-8", errors="replace")
        elif magic[:2] == b"\x1f\x8b":
            # gzip-compressed XML
            with gzip.open(ork_path, "rt", encoding="utf-8", errors="replace") as f:
                content = f.read()
        else:
            # plain XML
            with open(ork_path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()

        fin_iters = list(re.finditer(
            r"<freeformfinset>(.*?)</freeformfinset>", content, re.DOTALL | re.IGNORECASE
        ))
        if not fin_iters:
            return

        # Build body-tube position table (same approach as _fix_trap_fin_positions_from_ork)
        nc_m = re.search(r'<nosecone>.*?<length>([\d.eE+\-]+)</length>', content, re.DOTALL | re.IGNORECASE)
        nc_len = float(nc_m.group(1)) if nc_m else 0.0
        bt_data: list[tuple[int, int, float]] = []  # (xml_start, xml_end, length)
        for bm in re.finditer(r'<bodytube>(.*?)</bodytube>', content, re.DOTALL | re.IGNORECASE):
            ln_m = re.search(r'<length>([\d.eE+\-]+)</length>', bm.group(1), re.IGNORECASE)
            if ln_m:
                bt_data.append((bm.start(), bm.end(), float(ln_m.group(1))))

        trapezoidal_fins = {}
        for i, fin_m in enumerate(fin_iters):
            section = fin_m.group(1)
            fin_xml_start = fin_m.start()

            # fin count
            fc_match = re.search(r"<fincount>(\d+)</fincount>", section, re.IGNORECASE)
            n = int(fc_match.group(1)) if fc_match else 4

            # axial offset: extract both method and value
            ao_m = re.search(
                r'<axialoffset\s+method="([^"]+)"\s*>([\d.eE+\-]+)</axialoffset>',
                section, re.IGNORECASE,
            ) or re.search(
                r'<position\s+type="([^"]+)"\s*>([\d.eE+\-]+)</position>',
                section, re.IGNORECASE,
            )
            ao_method = ao_m.group(1).lower() if ao_m else "absolute"
            ao_value = float(ao_m.group(2)) if ao_m else 0.0

            # Compute absolute LE position using parent body-tube context
            if ao_method in ("absolute",):
                position = ao_value
            else:
                # Find enclosing body tube
                parent_idx = -1
                for j, (bt_start, bt_end, _) in enumerate(bt_data):
                    if bt_start < fin_xml_start < bt_end:
                        parent_idx = j
                if parent_idx >= 0:
                    parent_aft = nc_len + sum(bt_data[k][2] for k in range(parent_idx + 1))
                    parent_start = parent_aft - bt_data[parent_idx][2]
                    if ao_method in ("bottom", "after"):
                        # placeholder — root_chord not yet known; store raw, fix after geometry parsed
                        position = None  # resolved below after root_chord computed
                    else:
                        position = parent_start + ao_value
                else:
                    position = ao_value

            # fin points: (x=axial, y=radial)
            pts = re.findall(r'<point\s+x="([\d.eE+\-]+)"\s+y="([\d.eE+\-]+)"', section, re.IGNORECASE)
            if not pts:
                continue
            xs = [float(p[0]) for p in pts]
            ys = [float(p[1]) for p in pts]

            # Root chord: axial extent of points at y=0
            root_pts = [(x, y) for x, y in zip(xs, ys) if y < 1e-6]
            if len(root_pts) >= 2:
                root_xs = sorted(p[0] for p in root_pts)
                root_chord = root_xs[-1] - root_xs[0]
            else:
                root_chord = max(xs)

            # Resolve deferred "bottom" position now that root_chord is known
            if position is None:
                position = max(0.0, parent_aft - ao_value - root_chord)

            # Span: maximum radial extent
            span = max(ys)

            # Tip chord: axial extent of points at or near max span
            tip_pts = [(x, y) for x, y in zip(xs, ys) if abs(y - span) < 1e-5]
            if len(tip_pts) >= 2:
                tip_xs = sorted(p[0] for p in tip_pts)
                tip_chord = tip_xs[-1] - tip_xs[0]
            else:
                # approximate from span fraction
                tip_chord = root_chord * 0.4

            # Sweep: axial distance from root leading edge to tip leading edge
            if root_pts and tip_pts:
                root_le_x = min(p[0] for p in root_pts)
                tip_le_x = min(p[0] for p in tip_pts)
                sweep_length = tip_le_x - root_le_x
            else:
                sweep_length = (root_chord - tip_chord) / 2.0

            trapezoidal_fins[str(i)] = {
                "n": n,
                "root_chord": round(root_chord, 6),
                "tip_chord": round(tip_chord, 6),
                "span": round(span, 6),
                "position": round(position or 0.0, 6),
                "sweep_length": round(sweep_length, 6),
            }

        if trapezoidal_fins:
            params["trapezoidal_fins"] = trapezoidal_fins

    except Exception:
        pass  # non-fatal — simulation continues without fin approximation


def _extract_motor_designation(ork_path: str, params: dict) -> None:
    """Extract motor designation (e.g. 'M2500T-P') from .ork XML motor element."""
    try:
        content = _read_ork_xml(ork_path)
        match = re.search(r"<designation>(.*?)</designation>", content, re.IGNORECASE)
        if match:
            designation = match.group(1).strip()
            if designation:
                params.setdefault("motors", {})["designation"] = designation
                logger.info("_extract_motor_designation: %s", designation)
    except Exception as exc:
        logger.warning("_extract_motor_designation: failed (%s)", exc)


def _check_java_17_available() -> None:
    """Check if Java 17 is available on the system."""
    try:
        result = subprocess.run(
            ["java", "-version"],
            check=True,
            capture_output=True,
            text=True,
        )
        version_output = result.stderr + result.stdout
        if "17" not in version_output:
            raise RuntimeError(
                "Java 17 is required. Install from https://adoptium.net/"
            )
    except FileNotFoundError:
        raise RuntimeError(
            "Java 17 is required. Install from https://adoptium.net/"
        )
    except subprocess.CalledProcessError:
        raise RuntimeError(
            "Java 17 is required. Install from https://adoptium.net/"
        )


def _extract_or_stored_timeseries(ork_path: str, params: dict) -> None:
    """Extract OR stored simulation timeseries and at-launch stability from .ork datapoints.

    Adds to params["stored_results"]:
      - "or_timeseries": downsampled dict of time/altitude/velocity/mach/stability/thrust
      - "launch_stability_margin": stability at first powered timestep (matches OR display)
    """
    try:
        import math
        content = _read_ork_xml(ork_path)
        types_match = re.search(r'types="([^"]+)"', content, re.IGNORECASE)
        if not types_match:
            return
        types = types_match.group(1).split(",")

        col_names = {
            "Time": None, "Altitude": None, "Total velocity": None,
            "Mach number": None, "Stability margin calibers": None, "Thrust": None,
        }
        for name in col_names:
            if name in types:
                col_names[name] = types.index(name)

        if col_names["Time"] is None:
            return

        datapoints = re.findall(r"<datapoint>(.*?)</datapoint>", content, re.DOTALL | re.IGNORECASE)
        if not datapoints:
            return

        arrays: dict[str, list] = {k: [] for k in col_names}
        for dp in datapoints:
            vals = dp.strip().split(",")
            for name, idx in col_names.items():
                if idx is not None and idx < len(vals):
                    try:
                        arrays[name].append(float(vals[idx]))
                    except (ValueError, IndexError):
                        arrays[name].append(float("nan"))
                else:
                    arrays[name].append(float("nan"))

        # Extract OR simulation conditions (rail length, altitude) for comparison context
        cond_m = re.search(r'<conditions>(.*?)</conditions>', content, re.DOTALL | re.IGNORECASE)
        if cond_m:
            cond_sec = cond_m.group(1)
            rl_m = re.search(r'<launchrodlength>([\d.eE+\-]+)</launchrodlength>', cond_sec, re.IGNORECASE)
            if rl_m:
                params.setdefault("stored_results", {})["or_launch_rod_length_m"] = float(rl_m.group(1))
            alt_m = re.search(r'<launchaltitude>([\d.eE+\-]+)</launchaltitude>', cond_sec, re.IGNORECASE)
            if alt_m:
                params.setdefault("stored_results", {})["or_launch_altitude_m"] = float(alt_m.group(1))

        stab_list = arrays["Stability margin calibers"]
        launch_stab = next((s for s in stab_list if not math.isnan(s)), None)
        if launch_stab is not None:
            params.setdefault("stored_results", {})["launch_stability_margin"] = launch_stab
            logger.info("_extract_or_stored_timeseries: launch stability=%.3f cal", launch_stab)

        def clean(arr: list) -> list:
            return [0.0 if math.isnan(v) else v for v in arr]

        time_arr = clean(arrays["Time"])
        n = len(time_arr)
        if n == 0:
            return
        step = max(1, n // 500)
        idx_s = list(range(0, n, step))

        params.setdefault("stored_results", {})["or_timeseries"] = {
            "time":      [time_arr[i] for i in idx_s],
            "altitude":  [clean(arrays["Altitude"])[i] for i in idx_s],
            "velocity":  [clean(arrays["Total velocity"])[i] for i in idx_s],
            "mach":      [clean(arrays["Mach number"])[i] for i in idx_s],
            "stability": [clean(stab_list)[i] for i in idx_s],
            "thrust":    [clean(arrays["Thrust"])[i] for i in idx_s],
        }
        logger.info(
            "_extract_or_stored_timeseries: %d pts (downsampled from %d)", len(idx_s), n
        )
    except Exception as exc:
        logger.warning("_extract_or_stored_timeseries: failed (%s)", exc)


def _fix_fin_positions(ork_path: str, params: dict) -> None:
    """Fix fin leading-edge positions in params.

    rocketserializer exports fin position as the absolute position of the
    trailing edge of the root chord when the OR fin uses
    axialoffset method='bottom'.  RocketPy's add_trapezoidal_fins(position=…)
    expects the leading edge.  Subtract root_chord when the OR source method
    is 'bottom' (or 'after', which is synonymous).
    """
    try:
        content = _read_ork_xml(ork_path)

        # Build a list of (axialoffset_method, root_chord) from the XML fin sets.
        # OR uses <trapezoidfinset> or <trapezoidalfinset>.
        fin_sections = re.findall(
            r'<trapezoid(?:al)?finset>(.*?)</trapezoid(?:al)?finset>',
            content, re.DOTALL | re.IGNORECASE
        )
        if not fin_sections:
            return

        xml_fins = []
        for fs in fin_sections:
            method_m = re.search(r'<axialoffset\s+method="([^"]+)"', fs, re.IGNORECASE)
            method = method_m.group(1).lower() if method_m else "top"
            rc_m = re.search(r'<rootchord>([\d.eE+\-]+)</rootchord>', fs, re.IGNORECASE)
            root_chord = float(rc_m.group(1)) if rc_m else 0.0
            xml_fins.append((method, root_chord))

        fins_raw = params.get("trapezoidal_fins", {})
        fin_list = list(fins_raw.values()) if isinstance(fins_raw, dict) else fins_raw

        for i, fin in enumerate(fin_list):
            if i >= len(xml_fins):
                break
            method, root_chord_xml = xml_fins[i]
            if method in ("bottom", "after") and root_chord_xml > 0:
                old_pos = float(fin.get("position", 0) or 0)
                corrected = old_pos - root_chord_xml
                fin["position"] = round(corrected, 6)
                logger.info(
                    "_fix_fin_positions: fin %d method=%s pos %.4f -> %.4f (root_chord=%.4f)",
                    i, method, old_pos, corrected, root_chord_xml,
                )
    except Exception as exc:
        logger.warning("_fix_fin_positions: failed (%s)", exc)


def _fix_trap_fin_positions_from_ork(ork_path: str, params: dict) -> None:
    """Recompute trapezoid fin leading-edge positions from the OR XML component hierarchy.

    rocketserializer mis-computes absolute fin positions when the fin axialoffset
    method is 'bottom' (root trailing edge at body-tube aft).  We re-derive positions
    by sequentially summing nosecone + outer body-tube lengths to find the parent
    tube's absolute aft position, then apply:
        fin_LE_abs = parent.aft - ao_offset - root_chord   (method=bottom)
        fin_LE_abs = parent.start + ao_offset              (method=top)
    """
    try:
        content = _read_ork_xml(ork_path)

        fins_raw = params.get("trapezoidal_fins", {})
        if not fins_raw:
            return

        # Nosecone length (always starts at x=0 from nose tip)
        nc_m = re.search(r'<nosecone>.*?<length>([\d.eE+\-]+)</length>', content, re.DOTALL | re.IGNORECASE)
        nc_len = float(nc_m.group(1)) if nc_m else 0.0

        # Outer body tubes (<bodytube>, not <innertube>) in document order
        bt_data: list[tuple[int, int, float]] = []  # (xml_start, xml_end, length)
        for m in re.finditer(r'<bodytube>(.*?)</bodytube>', content, re.DOTALL | re.IGNORECASE):
            ln_m = re.search(r'<length>([\d.eE+\-]+)</length>', m.group(1), re.IGNORECASE)
            if ln_m:
                bt_data.append((m.start(), m.end(), float(ln_m.group(1))))

        if not bt_data:
            return

        fin_param_keys = list(fins_raw.keys()) if isinstance(fins_raw, dict) else list(range(len(fins_raw)))
        fin_xml_iters = list(re.finditer(
            r'<trapezoidfinset>(.*?)</trapezoidfinset>', content, re.DOTALL | re.IGNORECASE
        ))

        for i, (fin_key, fin_m) in enumerate(zip(fin_param_keys, fin_xml_iters)):
            fin_xml_start = fin_m.start()
            fin_section = fin_m.group(1)

            # axialoffset method and value (prefer <axialoffset>, fall back to <position type=...>)
            ao_m = re.search(
                r'<axialoffset\s+method="([^"]+)"\s*>([\d.eE+\-]+)</axialoffset>',
                fin_section, re.IGNORECASE,
            ) or re.search(
                r'<position\s+type="([^"]+)"\s*>([\d.eE+\-]+)</position>',
                fin_section, re.IGNORECASE,
            )
            ao_method = ao_m.group(1).lower() if ao_m else "top"
            ao_value = float(ao_m.group(2)) if ao_m else 0.0

            rc_m = re.search(r'<rootchord>([\d.eE+\-]+)</rootchord>', fin_section, re.IGNORECASE)
            root_chord = float(rc_m.group(1)) if rc_m else 0.0
            if root_chord <= 0:
                continue

            # Find nearest enclosing outer bodytube
            parent_idx = -1
            for j, (bt_start, bt_end, _) in enumerate(bt_data):
                if bt_start < fin_xml_start < bt_end:
                    parent_idx = j  # last match = innermost enclosing tube

            if parent_idx < 0:
                logger.warning("_fix_trap_fin_positions: fin[%s] not inside any bodytube — skipping", fin_key)
                continue

            # Sequential absolute aft position of parent (NC + all bodytubes up to parent)
            parent_aft_abs = nc_len + sum(bt_data[k][2] for k in range(parent_idx + 1))
            parent_start_abs = parent_aft_abs - bt_data[parent_idx][2]

            if ao_method in ("bottom", "after"):
                fin_le_abs = parent_aft_abs - ao_value - root_chord
            else:
                fin_le_abs = parent_start_abs + ao_value

            fin_le_abs = max(0.0, round(fin_le_abs, 6))

            fin = fins_raw[fin_key] if isinstance(fins_raw, dict) else fins_raw[fin_key]
            old_pos = fin.get("position", 0)
            fin["position"] = fin_le_abs
            logger.info(
                "_fix_trap_fin_positions: fin[%s] pos %.4f -> %.4f m "
                "(method=%s, offset=%.4f, rc=%.4f, parent_aft=%.4f)",
                fin_key, old_pos, fin_le_abs, ao_method, ao_value, root_chord, parent_aft_abs,
            )

    except Exception as exc:
        logger.warning("_fix_trap_fin_positions: failed (%s) — keeping serializer value", exc)


def _fix_rocket_mass(params: dict) -> None:
    """Remove motor dry mass from rocket.mass.

    rocketserializer exports rocket.mass as the total final (dry) system mass
    = airframe + motor casing.  RocketPy's Rocket(mass=…) expects the airframe
    alone; the motor is then added as a separate SolidMotor object which
    already carries dry_mass.  Without this fix we double-count the motor
    casing, making the rocket heavier and producing wrong velocity/acceleration.

    Also adjust center_of_mass_without_motor: rocketserializer exports the CG
    of the combined (airframe + motor-dry) system; subtract out the motor dry
    contribution to get the airframe-only CG for RocketPy.
    """
    try:
        rkt  = params["rocket"]
        mtr  = params["motors"]

        total_dry_mass = float(rkt.get("mass", 0) or 0)
        motor_dry_mass = float(mtr.get("dry_mass", 0) or 0)
        airframe_mass  = total_dry_mass - motor_dry_mass
        if airframe_mass <= 0:
            return  # data looks wrong — don't corrupt it

        # CG adjustment: back out the motor dry contribution.
        # motor_params["position"] is the motor aft face (nozzle reference) in nose_to_tail
        # rocket coordinates.  For nozzle_to_combustion_chamber orientation, motor internal
        # +x increases toward the combustion chamber (= toward nose = decreasing rocket x).
        # So motor dry CG in rocket coords = motor_pos - grain_stack_h / 2.
        _motor_pos  = float(mtr.get("position", 0) or 0)
        grain_h     = float(mtr.get("grain_initial_height", 0.1) or 0.1)
        grain_n     = max(1, int(mtr.get("grain_number", 1) or 1))
        stack_h     = grain_h * grain_n
        motor_dry_cg_rocket = _motor_pos - stack_h / 2.0

        total_dry_cg = float(rkt.get("center_of_mass_without_propellant", _motor_pos * 0.5) or _motor_pos * 0.5)
        airframe_cg  = (
            (total_dry_cg * total_dry_mass - motor_dry_cg_rocket * motor_dry_mass)
            / airframe_mass
        )

        rkt["mass"] = round(airframe_mass, 5)
        rkt["center_of_mass_without_propellant"] = round(airframe_cg, 5)
        logger.info(
            "_fix_rocket_mass: mass %.3f->%.3f kg, cm %.4f->%.4f m",
            total_dry_mass, airframe_mass, total_dry_cg, airframe_cg,
        )
    except Exception as exc:
        logger.warning("_fix_rocket_mass: failed (%s)", exc)


def validate_ork(ork_path: str) -> list[str]:
    """Inspect .ork XML and return human-readable warnings for unsupported configurations.

    Returns an empty list when the file looks fully supported.
    Never raises — validation failures become warnings themselves.
    """
    warnings: list[str] = []
    try:
        import xml.etree.ElementTree as ET
        xml_text = _read_ork_xml(ork_path)
        root = ET.fromstring(xml_text)

        rocket = root.find("rocket")
        if rocket is None:
            warnings.append("No <rocket> element found — file may be corrupt or unsupported.")
            return warnings

        # Multi-stage detection
        subs = rocket.find("subcomponents")
        stages = subs.findall("stage") if subs is not None else []
        if len(stages) > 1:
            warnings.append(
                f"Multi-stage rocket detected ({len(stages)} stages). "
                "Only the first stage is simulated; upper-stage results will be inaccurate."
            )

        # Clustered motor detection
        for innertube in root.iter("innertube"):
            cluster_cfg = innertube.findtext("clusterconfiguration", "single").strip().lower()
            if cluster_cfg not in ("", "single"):
                warnings.append(
                    f"Clustered motor mount detected (configuration: '{cluster_cfg}'). "
                    "Only the first motor is used; cluster thrust will be underestimated."
                )
                break

        # Pods / external components
        if list(root.iter("podset")):
            warnings.append(
                "Rocket has pod(s) / external components. "
                "Pods are not exported by rocketserializer and will be ignored in simulation."
            )

        # No saved simulation data
        sims = list(root.iter("simulation"))
        flight_data = list(root.iter("flightdata"))
        if sims and not flight_data:
            warnings.append(
                "No OpenRocket simulation results saved in this file. "
                "OR comparison data will be unavailable — only RocketPy results shown."
            )

        # No motor
        motors = list(root.iter("motor"))
        if not motors:
            warnings.append("No motor found in the .ork file. Simulation may fail or produce zero thrust.")

    except Exception as exc:
        warnings.append(f"Could not fully validate .ork file: {exc}")

    return warnings


def get_stored_results(params: dict) -> dict:
    """
    Extract OpenRocket's pre-computed simulation summary from parameters.

    Args:
        params: Dictionary from convert_ork() containing parsed parameters.json

    Returns:
        Stored results dictionary from OpenRocket simulation
    """
    return params.get("stored_results", {})
