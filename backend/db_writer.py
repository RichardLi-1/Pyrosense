import asyncio
import os
from pathlib import Path

import asyncpg
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / "tiger-cloud-db-64912-credentials.env")
CONNECTION = os.environ["TIMESCALE_SERVICE_URL"]


async def main():
    conn = await asyncpg.connect(CONNECTION)
    extensions = await conn.fetch("select extname, extversion from pg_extension")
    for extension in extensions:
        print(extension)
    await conn.close()

asyncio.run(main())