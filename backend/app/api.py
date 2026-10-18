"""REST + WebSocket routes. Routes are mounted at the root; nginx maps /api/* -> /*."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from .db import DatabaseUnavailable

log = logging.getLogger("api")
router = APIRouter()


def _parse_ts(v: str | None, name: str) -> datetime | None:
    if v is None or v == "":
        return None
    try:
        if v.replace(".", "", 1).isdigit():
            return datetime.fromtimestamp(float(v), tz=timezone.utc)
        dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        raise HTTPException(422, f"{name} must be ISO-8601 or unix seconds")


def _session(req: Request, session: str | None) -> str:
    return session or req.app.state.live.session


async def _db(req: Request, coro):
    try:
        return await coro
    except DatabaseUnavailable as e:
        raise HTTPException(503, f"database unavailable: {e}")


@router.get("/health")
async def health(req: Request):
    a = req.app.state
    return {"ok": True, "session": a.live.session, "bridge_connected": a.live.bridge_connected,
            "db": {"enabled": a.db.enabled, "connected": a.db.connected, "pending": a.db.pending,
                   "written": a.db.rows_written, "dropped": a.db.rows_dropped, "last_error": a.db.last_error},
            "ws_clients": a.bus.n_clients, "n_samples": a.live.n_samples,
            "has_map": a.live.map is not None, "gemini": a.summarizer.enabled}


class SessionBody(BaseModel):
    session: str


class SaveBody(BaseModel):
    name: str | None = None
    notes: str | None = None


class RestartBody(BaseModel):
    name: str | None = None  # becomes the new session id (slugified); blank = auto timestamp


def _slug(s: str) -> str:
    import re
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:48] or None


def _pi_control_url(settings) -> str | None:
    if settings.pi_control_url:
        return settings.pi_control_url.rstrip("/")
    u = settings.bridge_url
    if not u.startswith("ws"):
        return None
    host = u.split("://", 1)[1].split("/")[0].rsplit(":", 1)[0]
    return f"http://{host}:8766"


@router.get("/session")
async def get_session(req: Request):
    return {"session": req.app.state.live.session, "started": req.app.state.live.started_at.isoformat()}


@router.post("/session")
async def set_session(req: Request, body: SessionBody):
    a = req.app.state
    a.live.new_session(body.session.strip())
    a.alerts.reset()
    a.bus.publish(a.live.hello_event(a.alerts.threshold, a.settings.voc_unit))
    return {"session": a.live.session}


@router.post("/session/save")
async def save_session(req: Request, body: SaveBody):
    """Name the current scan and store its floor plan so it shows in the catalog."""
    a = req.app.state
    m = a.live.map
    await _db(req, a.db.save_session(
        a.live.session, body.name, body.notes, m.png if m else None,
        (m.grid.origin_x, m.grid.origin_y) if m else None, m.grid.resolution if m else None,
        (m.grid.width, m.grid.height) if m else None))
    try:
        await a.db.flush_now()
    except Exception:  # noqa: BLE001
        pass
    return {"session": a.live.session, "name": body.name, "saved": True, "has_map": m is not None}


@router.post("/session/restart")
async def restart_session(req: Request, body: RestartBody | None = None):
    """Start a fresh scan: save the current one, ask the Pi to restart SLAM + the VOC buffer, open a new session."""
    import asyncio as _asyncio
    import httpx
    from .config import auto_session
    a = req.app.state
    old = a.live.session
    m = a.live.map
    saved = False
    if a.db.connected and a.live.n_samples:
        try:
            await a.db.save_session(old, None, None, m.png if m else None,
                                    (m.grid.origin_x, m.grid.origin_y) if m else None, m.grid.resolution if m else None,
                                    (m.grid.width, m.grid.height) if m else None)
            saved = True
        except Exception as e:  # noqa: BLE001
            log.warning("could not snapshot %s before restart: %s", old, e)
    pi = {"url": _pi_control_url(a.settings), "ok": False, "error": None}
    if pi["url"]:
        try:
            async with httpx.AsyncClient(timeout=15) as c:
                r = await c.post(pi["url"] + "/restart")
                pi["ok"] = r.status_code == 200 and r.json().get("ok", False)
                if not pi["ok"]:
                    pi["error"] = r.text[:200]
        except Exception as e:  # noqa: BLE001
            pi["error"] = str(e)[:200]
    new = (_slug(body.name) if body and body.name else None) or auto_session()
    a.live.new_session(new)
    a.live.tracker.reset()  # the Pi restarts with an empty list, so all points after this are new
    a.ingest._backlog_checked = True  # new session has no stored rows; ingest everything that arrives
    a.live.map = None
    a.alerts.reset()
    a.bus.publish(a.live.hello_event(a.alerts.threshold, a.settings.voc_unit))
    return {"session": new, "previous": old, "previous_saved": saved, "pi": pi}


@router.get("/sessions")
async def sessions(req: Request):
    return await _db(req, req.app.state.db.sessions())


@router.get("/sessions/{session}/map.png")
async def session_map(req: Request, session: str):
    png = await _db(req, req.app.state.db.session_map_png(session))
    if not png:
        raise HTTPException(404, "no saved map for this session")
    return Response(png, media_type="image/png", headers={"Cache-Control": "public, max-age=3600"})


@router.get("/heatmap")
async def heatmap(req: Request, session: str | None = None, until: str | None = None,
                  half_life: float = Query(None, gt=0)):
    hl = half_life or req.app.state.settings.heatmap_default_half_life
    u = _parse_ts(until, "until")
    cells = await _db(req, req.app.state.db.heatmap(_session(req, session), u, hl))
    return {"session": _session(req, session), "cell_size": 0.2, "half_life": hl,
            "until": (u or datetime.now(timezone.utc)).isoformat(), "cells": cells}


@router.get("/trail")
async def trail(req: Request, session: str | None = None, since: str | None = None,
                until: str | None = None, limit: int = Query(20000, le=200000)):
    return await _db(req, req.app.state.db.trail(_session(req, session), _parse_ts(since, "since"),
                                                 _parse_ts(until, "until"), limit))


@router.get("/map")
async def map_png(req: Request, session: str | None = None, v: int | None = None):
    live = req.app.state.live
    if session and session != live.session:
        raise HTTPException(404, "map is only available for the live session")
    if live.map is None:
        raise HTTPException(404, "no map yet")
    g = live.map.grid
    return Response(live.map.png, media_type="image/png", headers={
        "X-Map-Origin": f"{g.origin_x},{g.origin_y}", "X-Map-Res": str(g.resolution),
        "X-Map-Size": f"{g.width},{g.height}", "X-Map-Version": str(live.map.version),
        "Cache-Control": "no-store",
        "Access-Control-Expose-Headers": "X-Map-Origin, X-Map-Res, X-Map-Size, X-Map-Version"})


@router.get("/map/meta")
async def map_meta(req: Request):
    live = req.app.state.live
    if live.map is None:
        raise HTTPException(404, "no map yet")
    return live.map.event()


@router.get("/alerts")
async def alerts(req: Request, session: str | None = None):
    return await _db(req, req.app.state.db.alerts(_session(req, session)))


@router.get("/alerts/{alert_id}/map.png")
async def alert_png(req: Request, alert_id: int):
    png = await _db(req, req.app.state.db.alert_png(alert_id))
    if not png:
        raise HTTPException(404, "no snapshot for this alert")
    return Response(png, media_type="image/png")


@router.get("/summary")
async def summary(req: Request, session: str | None = None, force: bool = False):
    a = req.app.state
    s = _session(req, session)
    stats, top, heat = await _db(req, asyncio.gather(
        a.db.session_stats(s), a.db.top_cells(s, 10), a.db.heatmap(s, None, a.settings.heatmap_default_half_life)))
    return await a.summarizer.summarize(s, stats, top, heat, force=force)


@router.websocket("/ws/live")
async def ws_live(ws: WebSocket, session: str | None = None):
    a = ws.app.state
    await ws.accept()
    q = a.bus.subscribe()
    try:
        await ws.send_json(a.live.hello_event(a.alerts.threshold, a.settings.voc_unit))
        if a.live.map:
            await ws.send_json(a.live.map.event())
        pe = a.live.pose_event()
        if pe:
            await ws.send_json(pe)

        async def reader():  # drain client pings / ignore payloads
            while True:
                await ws.receive_text()

        reader_task = asyncio.create_task(reader())
        try:
            while True:
                ev = await q.get()
                await ws.send_json(ev)
        finally:
            reader_task.cancel()
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        a.bus.unsubscribe(q)


@router.get("/")
async def index():
    return JSONResponse({"name": "PROJECT_NAME backend", "docs": "/docs", "live": "/ws/live"})
