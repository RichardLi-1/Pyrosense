"""FoxgloveClient and the whole app against a real Foxglove WebSocket server
(the same library tools/fake_pi.py uses), so the protocol path is exercised end to end."""
import asyncio
import logging

import numpy as np
import pytest
from foxglove_websocket.server import FoxgloveServer

from app.foxglove import FoxgloveClient, build_decoder
from app.main import create_app
from app.ros_schemas import SCHEMAS
from tests.conftest import free_port, make_settings, wait_for
from tools.fake_pi import encode_points, encode_pose

POSE = "geometry_msgs/msg/PoseWithCovarianceStamped"
CLOUD = "sensor_msgs/msg/PointCloud2"


async def channel(server, topic, schema, encoding="cdr", schema_text=None):
    return await server.add_channel({"topic": topic, "encoding": encoding, "schemaName": schema,
                                     "schema": SCHEMAS[schema] if schema_text is None else schema_text,
                                     "schemaEncoding": "ros2msg"})


async def start_client(port, topics, **kw):
    got = []
    client = FoxgloveClient(f"ws://127.0.0.1:{port}", topics, lambda t, m, ns: got.append((t, m, ns)),
                            min_backoff=0.05, max_backoff=0.1, **kw)
    return client, got, asyncio.create_task(client.run_forever())


async def stop(task):
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


def test_build_decoder_accepts_both_schema_name_forms():
    for name in (POSE, "geometry_msgs/PoseWithCovarianceStamped"):
        assert build_decoder(name, SCHEMAS[POSE])(encode_pose(1, 2, 0)).pose.pose.position.x == 1
    with pytest.raises(ValueError, match="jsonschema"):
        build_decoder(POSE, "{}", "jsonschema")


async def test_subscribes_only_to_wanted_cdr_topics():
    port = free_port()
    async with FoxgloveServer("127.0.0.1", port, "test") as server:
        pose = await channel(server, "/pose", POSE)
        scan = await channel(server, "/scan", POSE)                       # not wanted
        js = await channel(server, "/voc_points", CLOUD, encoding="json")  # wrong encoding
        client, got, task = await start_client(port, {"/pose", "/voc_points"})
        await wait_for(lambda: server._any_subscribed(pose))
        assert client.connected and not server._any_subscribed(scan) and not server._any_subscribed(js)
        await server.send_message(pose, 123, encode_pose(4.35, -1.04, 0.5))
        await wait_for(lambda: got)
        topic, msg, recv_ns = got[0]
        assert topic == "/pose" and msg.pose.pose.position.x == 4.35 and recv_ns == 123
        await stop(task)


async def test_bad_schema_and_corrupt_payload_dont_break_stream(caplog):
    port = free_port()
    async with FoxgloveServer("127.0.0.1", port, "test") as server:
        bad = await channel(server, "/voc_points", CLOUD, schema_text="not a ros2msg ::")
        pose = await channel(server, "/pose", POSE)
        client, got, task = await start_client(port, {"/pose", "/voc_points"})
        with caplog.at_level(logging.ERROR):
            await wait_for(lambda: server._any_subscribed(pose))
            assert not server._any_subscribed(bad)
            await server.send_message(pose, 1, b"\x00\x01\x00\x00\x01")    # truncated CDR
            await server.send_message(pose, 2, encode_pose(1, 2, 0))
            await wait_for(lambda: got)
        assert [ns for _, _, ns in got] == [2]
        assert "cannot build decoder for /voc_points" in caplog.text and "decode failed on /pose" in caplog.text
        await stop(task)


async def test_unadvertise_drops_subscription():
    port = free_port()
    async with FoxgloveServer("127.0.0.1", port, "test") as server:
        pose = await channel(server, "/pose", POSE)
        client, _, task = await start_client(port, {"/pose"})
        await wait_for(lambda: server._any_subscribed(pose))
        await server.remove_channel(pose)
        await wait_for(lambda: not client._subs)
        await stop(task)


async def test_reconnects_after_bridge_restart():
    port = free_port()
    async with FoxgloveServer("127.0.0.1", port, "test") as server:
        pose = await channel(server, "/pose", POSE)
        client, got, task = await start_client(port, {"/pose"})
        await wait_for(lambda: server._any_subscribed(pose))
    await wait_for(lambda: not client.connected)
    async with FoxgloveServer("127.0.0.1", port, "test") as server:   # Pi bridge comes back
        pose = await channel(server, "/pose", POSE)
        await wait_for(lambda: server._any_subscribed(pose))
        await server.send_message(pose, 9, encode_pose(1, 2, 0))
        await wait_for(lambda: got)
        assert client.connected and got[0][2] == 9
        await stop(task)


async def test_app_end_to_end_over_bridge():
    port = free_port()
    async with FoxgloveServer("127.0.0.1", port, "fake_pi") as server:
        pose = await channel(server, "/pose", POSE)
        pts = await channel(server, "/voc_points", CLOUD)
        app = create_app(make_settings(bridge_url=f"ws://127.0.0.1:{port}", voc_threshold=250), connect_bridge=True)
        async with app.router.lifespan_context(app):
            q = app.state.bus.subscribe()
            await wait_for(lambda: server._any_subscribed(pose) and server._any_subscribed(pts))
            await server.send_message(pose, 1, encode_pose(1.0, 2.0, 0.0))
            cloud = np.array([(1, 2, 0, 120), (1.2, 2, 0, 410)], "<f4")
            await server.send_message(pts, 2, encode_points(cloud, np.array([100.0, 101.0])))
            await wait_for(lambda: app.state.live.n_samples == 2)
            await wait_for(lambda: app.state.live.bridge_connected)  # status is polled every 0.5 s
            events = [q.get_nowait() for _ in range(q.qsize())]
            assert {"pose", "voc", "alert"} <= {e["t"] for e in events}
            assert {"t": "bridge", "connected": True} in events
