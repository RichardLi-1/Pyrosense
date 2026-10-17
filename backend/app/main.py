"""FastAPI application factory and process lifecycle."""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .alerts import AlertEngine
from .api import router
from .config import TOPICS, Settings
from .db import Database
from .foxglove import FoxgloveClient
from .gemini import Summarizer
from .ingest import Ingest
from .state import Broadcaster, LiveState

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("main")


def create_app(settings: Settings | None = None, *, connect_bridge: bool = True) -> FastAPI:
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        st = app.state
        st.settings = settings
        st.live = LiveState(settings.session, settings.voc_window_seconds)
        st.bus = Broadcaster()
        st.db = Database(settings.database_url, flush_seconds=settings.db_flush_seconds,
                         max_buffer_rows=settings.db_max_buffer_rows)
        st.alerts = AlertEngine(settings.voc_threshold, settings.voc_hold_seconds, settings.alert_cooldown_seconds)
        st.summarizer = Summarizer(settings.gemini_api_key, settings.gemini_model, settings.summary_cache_seconds)
        st.ingest = Ingest(settings, st.live, st.db, st.bus, st.alerts)
        st.bridge = FoxgloveClient(settings.bridge_url, TOPICS, st.ingest.on_message)
        log.info("session=%s bridge=%s db=%s gemini=%s", settings.session, settings.bridge_url,
                 "on" if settings.database_url else "off", "on" if st.summarizer.enabled else "fallback")
        await st.db.start()
        tasks = []
        if connect_bridge:
            tasks.append(asyncio.create_task(st.bridge.run_forever(), name="bridge"))
            tasks.append(asyncio.create_task(_mirror_bridge_status(st), name="bridge-status"))
        try:
            yield
        finally:
            for t in tasks:
                t.cancel()
            for t in tasks:
                try:
                    await t
                except (asyncio.CancelledError, Exception):  # noqa: BLE001
                    pass
            await st.db.stop()

    app = FastAPI(title="PROJECT_NAME backend", lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
                       expose_headers=["X-Map-Origin", "X-Map-Res", "X-Map-Size", "X-Map-Version"])
    app.include_router(router)
    return app


async def _mirror_bridge_status(st) -> None:
    prev = None
    while True:
        cur = st.bridge.connected
        if cur != prev:
            st.live.bridge_connected = cur
            st.bus.publish({"t": "bridge", "connected": cur})
            prev = cur
        await asyncio.sleep(0.5)


app = create_app()
