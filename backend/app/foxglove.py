"""Async client for the Foxglove WebSocket protocol (foxglove.websocket.v1).

foxglove_bridge on the Pi advertises every ROS 2 topic with its schema text and
streams CDR-encoded messages. We subscribe to the topics we care about, build a
decoder per channel from the advertised schema, and hand decoded messages to a
callback. Reconnects forever with backoff.
"""
from __future__ import annotations

import asyncio
import json
import logging
import struct
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Iterable

import websockets
from mcap_ros2._dynamic import generate_dynamic

log = logging.getLogger("foxglove")

# ws-protocol v1 (older C++ bridge, Python servers) and the Rust SDK bridge shipped with Jazzy
SUBPROTOCOLS = ["foxglove.sdk.v1", "foxglove.websocket.v1"]
OP_MESSAGE_DATA = 1
_MSG_HEADER = struct.Struct("<BIQ")  # opcode, subscription id, receive time (ns)

MessageHandler = Callable[[str, Any, int], Awaitable[None] | None]


@dataclass
class Channel:
    id: int
    topic: str
    schema_name: str
    decoder: Callable[[bytes], Any]


def build_decoder(schema_name: str, schema_text: str, schema_encoding: str = "ros2msg"):
    if schema_encoding not in ("ros2msg", ""):
        raise ValueError(f"unsupported schema encoding {schema_encoding!r} for {schema_name}")
    decoders = generate_dynamic(schema_name, schema_text)
    short = schema_name.replace("/msg/", "/")
    return decoders.get(schema_name) or decoders[short]


class FoxgloveClient:
    def __init__(self, url: str, topics: Iterable[str], on_message: MessageHandler,
                 *, min_backoff: float = 1.0, max_backoff: float = 15.0) -> None:
        self.url = url
        self.topics = set(topics)
        self.on_message = on_message
        self.min_backoff = min_backoff
        self.max_backoff = max_backoff
        self.connected = False
        self._subs: dict[int, Channel] = {}  # subscription id -> channel
        self._next_sub_id = 1

    async def run_forever(self) -> None:
        backoff = self.min_backoff
        while True:
            try:
                await self._session()
                backoff = self.min_backoff
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("bridge %s: %s (retry in %.0fs)", self.url, e, backoff)
            self.connected = False
            await asyncio.sleep(backoff)
            backoff = min(self.max_backoff, backoff * 2)

    async def _session(self) -> None:
        # Generous keepalive: over a phone hotspot the Pi link stalls for 20-40 s at a time, and every
        # drop costs a resubscribe plus a full point-cloud backlog. Only give up after ~90 s of silence.
        async with websockets.connect(self.url, subprotocols=SUBPROTOCOLS, max_size=None,
                                      ping_interval=30, ping_timeout=90, open_timeout=30) as ws:
            self.connected = True
            self._subs.clear()
            log.info("connected to %s (%s)", self.url, ws.subprotocol)
            async for raw in ws:
                if isinstance(raw, (bytes, bytearray)):
                    await self._on_binary(raw)
                else:
                    await self._on_json(ws, json.loads(raw))

    async def _on_json(self, ws, msg: dict) -> None:
        op = msg.get("op")
        if op == "serverInfo":
            log.info("server %s capabilities=%s", msg.get("name"), msg.get("capabilities"))
        elif op == "advertise":
            subs = []
            for ch in msg.get("channels", []):
                topic = ch["topic"]
                if topic not in self.topics:
                    continue
                if ch.get("encoding") != "cdr":
                    log.warning("%s uses encoding %s, skipping", topic, ch.get("encoding"))
                    continue
                try:
                    decoder = build_decoder(ch["schemaName"], ch.get("schema", ""),
                                            ch.get("schemaEncoding", "ros2msg"))
                except Exception as e:  # noqa: BLE001
                    log.error("cannot build decoder for %s (%s): %s", topic, ch["schemaName"], e)
                    continue
                sub_id = self._next_sub_id
                self._next_sub_id += 1
                self._subs[sub_id] = Channel(ch["id"], topic, ch["schemaName"], decoder)
                subs.append({"id": sub_id, "channelId": ch["id"]})
                log.info("subscribing %s (%s)", topic, ch["schemaName"])
            if subs:
                await ws.send(json.dumps({"op": "subscribe", "subscriptions": subs}))
        elif op == "unadvertise":
            gone = set(msg.get("channelIds", []))
            self._subs = {s: c for s, c in self._subs.items() if c.id not in gone}
        elif op == "status":
            log.info("bridge status: %s", msg.get("message"))

    async def _on_binary(self, raw: bytes) -> None:
        opcode = raw[0]
        if opcode != OP_MESSAGE_DATA:
            return
        _, sub_id, recv_ns = _MSG_HEADER.unpack_from(raw, 0)
        ch = self._subs.get(sub_id)
        if ch is None:
            return
        payload = raw[_MSG_HEADER.size:]
        try:
            decoded = ch.decoder(bytes(payload))
        except Exception as e:  # noqa: BLE001
            log.error("decode failed on %s: %s", ch.topic, e)
            return
        result = self.on_message(ch.topic, decoded, recv_ns)
        if asyncio.iscoroutine(result):
            await result
