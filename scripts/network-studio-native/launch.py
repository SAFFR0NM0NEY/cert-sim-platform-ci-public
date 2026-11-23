"""Start the local Network Studio native-file workspace."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import build_opener, ProxyHandler
import webbrowser

PORT = 42397
URL = f"http://127.0.0.1:{PORT}"
HERE = Path(__file__).resolve().parent


def running():
    try:
        with build_opener(ProxyHandler({})).open(
            URL + "/native/status", timeout=0.5
        ) as reply:
            return json.load(reply).get("service") == "certsim-native-files"
    except (URLError, ValueError, OSError, AttributeError):
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    app = HERE / "CertSim-Network-Studio.html"
    if not app.is_file():
        app = HERE.parents[1] / "dist-network-studio" / "network-studio.html"
    if not app.is_file():
        raise SystemExit(
            "Build the Network Studio preview with npm run build:network-studio first."
        )
    if not running():
        if sys.version_info < (3, 10):
            raise SystemExit(
                "Install Python 3.10 or later to use native Packet Tracer files."
            )
        data_location = (
            os.environ.get("LOCALAPPDATA")
            or os.environ.get("XDG_DATA_HOME")
            or Path.home() / ".local" / "share"
        )
        environment = (
            Path(data_location) / "CertSim" / "NativeFiles" / "0.4.1-lxml6.0.2"
        )
        python = environment / (
            "Scripts/python.exe" if os.name == "nt" else "bin/python"
        )
        if not python.is_file():
            subprocess.run([sys.executable, "-m", "venv", str(environment)], check=True)
        installed = subprocess.run(
            [
                str(python),
                "-c",
                "from importlib.metadata import version; assert version('packet-tracer-pkt-format')=='0.4.1' and version('lxml')=='6.0.2'",
            ],
            stderr=subprocess.DEVNULL,
        )
        if installed.returncode:
            subprocess.run(
                [
                    str(python),
                    "-m",
                    "pip",
                    "install",
                    "--disable-pip-version-check",
                    "-r",
                    str(HERE / "requirements.txt"),
                ],
                check=True,
            )
        log = environment / "network-studio.log"
        with log.open("a", encoding="utf-8") as output:
            process = subprocess.Popen(
                [str(python), "-B", str(HERE / "serve.py"), "--app", str(app)],
                stdin=subprocess.DEVNULL,
                stdout=output,
                stderr=output,
                start_new_session=os.name != "nt",
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
        for _ in range(60):
            if running():
                break
            if process.poll() is not None:
                raise SystemExit(
                    f"Could not start the native-file workspace. See {log}"
                )
            time.sleep(0.25)
        else:
            raise SystemExit(f"Timed out opening the native-file workspace. See {log}")
    address = URL + "/network-studio.html"
    print(address, flush=True)
    if not args.no_browser:
        webbrowser.open(address)


if __name__ == "__main__":
    main()
