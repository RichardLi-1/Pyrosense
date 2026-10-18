#!/usr/bin/env python3
"""Tiny control endpoint on the Pi so the backend can restart a scan.

  POST /restart   -> systemctl restart wearable  (fresh SLAM map, empty VOC buffer, new bag)
  GET  /status    -> {"active": "...", "uptime": ...}

Listens on :8766 (Tailscale/LAN). No auth: the Pi is only reachable on the tailnet/hotspot.
"""
import json
import subprocess
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 8766
UNIT = "wearable"


def run(*cmd):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=60)


class H(BaseHTTPRequestHandler):
    def _json(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/status"):
            st = run("systemctl", "is-active", UNIT).stdout.strip()
            since = run("systemctl", "show", UNIT, "-p", "ActiveEnterTimestampMonotonic", "--value").stdout.strip()
            return self._json(200, {"active": st, "active_since_monotonic_us": since, "now": time.time()})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path.startswith("/restart"):
            r = run("sudo", "-n", "systemctl", "restart", UNIT)
            ok = r.returncode == 0
            return self._json(200 if ok else 500, {"ok": ok, "stderr": r.stderr[-300:]})
        self._json(404, {"error": "not found"})

    def log_message(self, fmt, *args):  # quieter journal
        pass


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", PORT), H).serve_forever()
