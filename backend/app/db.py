"""Tiger Data access: batched reading writes, heat map / trail / alert / session queries.

The live path never awaits the DB. Readings go into a bounded in-memory buffer
that a background task flushes once per second with COPY. If the DB is down
the buffer keeps the newest rows and the API returns 503 for DB-backed routes.
"""
from __future__ import annotations

import asyncio
import logging
from collections import deque
from datetime import datetime, timezone
from typing import Any

import asyncpg

log = logging.getLogger("db")

HEATMAP_SQL = """
SELECT cx, cy,
       sum(mean * n * w) / sum(n * w)                                   AS mean,
       sum(n * w)                                                       AS weight,
       sqrt(greatest(0,
            sum(n * w * (coalesce(sd, 0)^2 + mean^2)) / sum(n * w)
            - (sum(mean * n * w) / sum(n * w))^2))                     AS sd,
       sum(n)::bigint                                                   AS n
FROM (
  SELECT *, power(0.5, extract(epoch FROM ($2::timestamptz - bucket)) / $3) AS w
  FROM voc_cells
  WHERE session = $1 AND bucket <= $2
) t
GROUP BY cx, cy
"""

TRAIL_SQL = """
SELECT ts, x, y, heading, voc FROM readings
WHERE session = $1 AND ts >= $2 AND ts <= $3
ORDER BY ts
LIMIT $4
"""

SESSIONS_SQL = """
SELECT r.session, r.started, r.ended, r.n, m.name, m.notes, m.saved_at, m.map_png IS NOT NULL AS has_map,
       m.map_origin_x, m.map_origin_y, m.map_res, m.map_w, m.map_h
FROM (SELECT session, min(ts) AS started, max(ts) AS ended, count(*) AS n FROM readings GROUP BY session) r
LEFT JOIN sessions_meta m USING (session)
ORDER BY r.ended DESC
"""

TOP_CELLS_SQL = """
SELECT cx, cy, sum(mean * n) / sum(n) AS mean, sum(n)::bigint AS n,
       min(bucket) AS first_seen, max(bucket) AS last_seen
FROM voc_cells WHERE session = $1
GROUP BY cx, cy ORDER BY mean DESC LIMIT $2
"""

SESSION_STATS_SQL = """
SELECT count(*) AS n, min(ts) AS started, max(ts) AS ended,
       avg(voc) AS mean, max(voc) AS peak,
       count(DISTINCT (floor(x/0.2)::int, floor(y/0.2)::int)) AS cells
FROM readings WHERE session = $1
"""


class Database:
    def __init__(self, url: str | None, *, flush_seconds: float = 1.0, max_buffer_rows: int = 50_000) -> None:
        self.url = url
        self.flush_seconds = flush_seconds
        self.pool: asyncpg.Pool | None = None
        self._buf: deque[tuple] = deque(maxlen=max_buffer_rows)
        self._task: asyncio.Task | None = None
        self.rows_written = 0
        self.rows_dropped = 0
        self.last_error: str | None = None

    @property
    def enabled(self) -> bool:
        return self.url is not None

    @property
    def connected(self) -> bool:
        return self.pool is not None

    @property
    def pending(self) -> int:
        return len(self._buf)

    async def start(self) -> None:
        if not self.enabled:
            log.warning("DATABASE_URL not set: running without persistence")
            return
        self._task = asyncio.create_task(self._writer_loop(), name="db-writer")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self.pool:
            try:
                await self._flush()
            except Exception:  # noqa: BLE001
                pass
            await self.pool.close()
            self.pool = None

    async def _connect(self) -> None:
        self.pool = await asyncpg.create_pool(self.url, min_size=1, max_size=4, command_timeout=30)
        log.info("connected to database")

    async def _writer_loop(self) -> None:
        backoff = 1.0
        while True:
            try:
                if self.pool is None:
                    await self._connect()
                    backoff = 1.0
                await asyncio.sleep(self.flush_seconds)
                await self._flush()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                self.last_error = str(e)
                log.warning("db writer: %s (%d rows buffered, retry in %.0fs)", e, len(self._buf), backoff)
                if self.pool is not None:
                    await self.pool.close()
                    self.pool = None
                await asyncio.sleep(backoff)
                backoff = min(30.0, backoff * 2)

    def add_readings(self, rows: list[tuple]) -> None:
        """rows: (ts, session, x, y, heading, voc). Never blocks."""
        if not self.enabled:
            return
        before = len(self._buf)
        self._buf.extend(rows)
        overflow = before + len(rows) - len(self._buf)
        if overflow > 0:
            self.rows_dropped += overflow

    async def _flush(self) -> None:
        if not self._buf or self.pool is None:
            return
        # Take the batch out before awaiting: rows added during the COPY then can't
        # evict batch rows from the full deque and get popped unwritten afterwards.
        batch = list(self._buf)
        self._buf.clear()
        try:
            async with self.pool.acquire() as conn:
                await conn.copy_records_to_table(
                    "readings", records=batch, columns=["ts", "session", "x", "y", "heading", "voc"])
        except BaseException:
            self._requeue(batch)
            raise
        self.rows_written += len(batch)

    def _requeue(self, batch: list[tuple]) -> None:
        """Put an unwritten batch back in front of newer rows, keeping the newest if over capacity."""
        rows = batch + list(self._buf)
        cap = self._buf.maxlen or len(rows)
        if len(rows) > cap:
            self.rows_dropped += len(rows) - cap
            rows = rows[-cap:]
        self._buf = deque(rows, maxlen=cap)

    async def flush_now(self) -> None:
        await self._flush()

    # ---- queries -------------------------------------------------------------

    def _require(self) -> asyncpg.Pool:
        if self.pool is None:
            raise DatabaseUnavailable(self.last_error or "database not connected")
        return self.pool

    async def heatmap(self, session: str, until: datetime | None, half_life: float) -> list[dict[str, Any]]:
        pool = self._require()
        until = until or datetime.now(timezone.utc)
        rows = await pool.fetch(HEATMAP_SQL, session, until, max(half_life, 1e-3))
        return [{"cx": r["cx"], "cy": r["cy"], "mean": float(r["mean"]), "weight": float(r["weight"]),
                 "sd": float(r["sd"] or 0.0), "n": int(r["n"])} for r in rows]

    async def trail(self, session: str, since: datetime | None, until: datetime | None,
                    limit: int = 20_000) -> list[dict[str, Any]]:
        pool = self._require()
        since = since or datetime(1970, 1, 1, tzinfo=timezone.utc)
        until = until or datetime.now(timezone.utc)
        rows = await pool.fetch(TRAIL_SQL, session, since, until, limit)
        return [{"ts": r["ts"].isoformat(), "x": r["x"], "y": r["y"], "heading": r["heading"], "voc": r["voc"]}
                for r in rows]

    async def sessions(self) -> list[dict[str, Any]]:
        pool = self._require()
        rows = await pool.fetch(SESSIONS_SQL)
        return [{"session": r["session"], "name": r["name"], "notes": r["notes"],
                 "saved": r["saved_at"].isoformat() if r["saved_at"] else None,
                 "started": r["started"].isoformat(), "ended": r["ended"].isoformat(), "n": int(r["n"]),
                 "map_png_url": f"/sessions/{r['session']}/map.png" if r["has_map"] else None,
                 "map": {"origin": [r["map_origin_x"], r["map_origin_y"]], "res": r["map_res"],
                         "w": r["map_w"], "h": r["map_h"]} if r["has_map"] else None} for r in rows]

    async def save_session(self, session: str, name: str | None, notes: str | None, map_png: bytes | None,
                           origin: tuple[float, float] | None, res: float | None, size: tuple[int, int] | None) -> None:
        pool = self._require()
        ox, oy = origin if origin else (None, None)
        w, h = size if size else (None, None)
        await pool.execute(
            "INSERT INTO sessions_meta (session, name, notes, saved_at, map_png, map_origin_x, map_origin_y, map_res, map_w, map_h) "
            "VALUES ($1,$2,$3,now(),$4,$5,$6,$7,$8,$9) "
            "ON CONFLICT (session) DO UPDATE SET name = COALESCE(EXCLUDED.name, sessions_meta.name), "
            "notes = COALESCE(EXCLUDED.notes, sessions_meta.notes), saved_at = now(), "
            "map_png = COALESCE(EXCLUDED.map_png, sessions_meta.map_png), "
            "map_origin_x = COALESCE(EXCLUDED.map_origin_x, sessions_meta.map_origin_x), "
            "map_origin_y = COALESCE(EXCLUDED.map_origin_y, sessions_meta.map_origin_y), "
            "map_res = COALESCE(EXCLUDED.map_res, sessions_meta.map_res), "
            "map_w = COALESCE(EXCLUDED.map_w, sessions_meta.map_w), map_h = COALESCE(EXCLUDED.map_h, sessions_meta.map_h)",
            session, name, notes, map_png, ox, oy, res, w, h)

    async def wait_connected(self, timeout: float = 8.0) -> bool:
        import asyncio as _a
        t0 = _a.get_event_loop().time()
        while self.pool is None and _a.get_event_loop().time() - t0 < timeout:
            await _a.sleep(0.2)
        return self.pool is not None

    async def latest_session(self, max_age_s: float) -> str | None:
        """Most recent session whose last reading is younger than max_age_s (to resume after a restart)."""
        if self.pool is None:
            return None
        row = await self.pool.fetchrow(
            "SELECT session, max(ts) AS last FROM readings GROUP BY session ORDER BY last DESC LIMIT 1")
        if not row or row["last"] is None:
            return None
        from datetime import datetime, timezone
        age = (datetime.now(timezone.utc) - row["last"]).total_seconds()
        return row["session"] if age <= max_age_s else None

    async def count_readings(self, session: str) -> int:
        pool = self._require()
        return int(await pool.fetchval("SELECT count(*) FROM readings WHERE session = $1", session))

    async def session_map_png(self, session: str) -> bytes | None:
        pool = self._require()
        return await pool.fetchval("SELECT map_png FROM sessions_meta WHERE session = $1", session)

    async def insert_alert(self, ts: datetime, session: str, x: float | None, y: float | None, voc: float,
                           map_png: bytes | None, map_origin: tuple[float, float] | None,
                           map_res: float | None) -> int | None:
        if self.pool is None:
            return None
        ox, oy = map_origin if map_origin else (None, None)
        return await self.pool.fetchval(
            "INSERT INTO alerts (ts, session, x, y, voc, map_png, map_origin_x, map_origin_y, map_res) "
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",
            ts, session, x, y, voc, map_png, ox, oy, map_res)

    async def alerts(self, session: str) -> list[dict[str, Any]]:
        pool = self._require()
        rows = await pool.fetch(
            "SELECT id, ts, x, y, voc, map_png IS NOT NULL AS has_png, map_origin_x, map_origin_y, map_res "
            "FROM alerts WHERE session = $1 ORDER BY ts DESC LIMIT 200", session)
        return [{"id": r["id"], "ts": r["ts"].isoformat(), "x": r["x"], "y": r["y"], "voc": r["voc"],
                 "map_png_url": f"/alerts/{r['id']}/map.png" if r["has_png"] else None,
                 "map_origin": [r["map_origin_x"], r["map_origin_y"]] if r["map_res"] else None,
                 "map_res": r["map_res"]} for r in rows]

    async def alert_png(self, alert_id: int) -> bytes | None:
        pool = self._require()
        return await pool.fetchval("SELECT map_png FROM alerts WHERE id = $1", alert_id)

    async def top_cells(self, session: str, limit: int = 10) -> list[dict[str, Any]]:
        pool = self._require()
        rows = await pool.fetch(TOP_CELLS_SQL, session, limit)
        return [{"cx": r["cx"], "cy": r["cy"], "mean": float(r["mean"]), "n": int(r["n"]),
                 "first_seen": r["first_seen"].isoformat(), "last_seen": r["last_seen"].isoformat()}
                for r in rows]

    async def session_stats(self, session: str) -> dict[str, Any]:
        pool = self._require()
        r = await pool.fetchrow(SESSION_STATS_SQL, session)
        return {"n": int(r["n"]), "started": r["started"].isoformat() if r["started"] else None,
                "ended": r["ended"].isoformat() if r["ended"] else None,
                "mean": float(r["mean"]) if r["mean"] is not None else None,
                "peak": float(r["peak"]) if r["peak"] is not None else None, "cells": int(r["cells"])}


class DatabaseUnavailable(RuntimeError):
    pass
