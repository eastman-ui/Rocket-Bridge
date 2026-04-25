import json
import os
import subprocess
from pathlib import Path


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
            return json.load(f)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Failed to parse parameters.json: {e}")


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


def get_stored_results(params: dict) -> dict:
    """
    Extract OpenRocket's pre-computed simulation summary from parameters.

    Args:
        params: Dictionary from convert_ork() containing parsed parameters.json

    Returns:
        Stored results dictionary from OpenRocket simulation
    """
    return params.get("stored_results", {})
