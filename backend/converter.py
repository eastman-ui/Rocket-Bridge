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

        fin_sections = re.findall(
            r"<freeformfinset>(.*?)</freeformfinset>", content, re.DOTALL | re.IGNORECASE
        )
        if not fin_sections:
            return

        trapezoidal_fins = {}
        for i, section in enumerate(fin_sections):
            # fin count
            fc_match = re.search(r"<fincount>(\d+)</fincount>", section, re.IGNORECASE)
            n = int(fc_match.group(1)) if fc_match else 4

            # axial position (leading edge of root from nose)
            pos_match = re.search(
                r'<position[^>]*type=["\']absolute["\'][^>]*>([\d.eE+\-]+)</position>',
                section, re.IGNORECASE
            ) or re.search(r"<axialoffset[^>]*>([\d.eE+\-]+)</axialoffset>", section, re.IGNORECASE)
            position = float(pos_match.group(1)) if pos_match else 0.0

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
                "position": round(position, 6),
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


def get_stored_results(params: dict) -> dict:
    """
    Extract OpenRocket's pre-computed simulation summary from parameters.

    Args:
        params: Dictionary from convert_ork() containing parsed parameters.json

    Returns:
        Stored results dictionary from OpenRocket simulation
    """
    return params.get("stored_results", {})
