"""Discord bot for CHECKNE.

What it does:
  - provides basic commands in your Discord server to see site stats
    (total users, registered today, online users)

How to run locally:
  1) pip install -r requirements.txt
  2) export DISCORD_BOT_TOKEN=...
  3) export DATABASE_URL=...  (same as your backend)
  4) python -m src.bot.discord_bot

If you deploy on Render:
  - create a separate "Worker" service for this script
  - set env vars DISCORD_BOT_TOKEN and DATABASE_URL
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import discord
from discord.ext import commands

from src.app.db import db


def _iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _scalar(sql: str, params: tuple = ()) -> int:
    row = db._fetchone(sql, params)  # type: ignore[attr-defined]
    if not row:
        return 0
    v = next(iter(row.values()))
    try:
        return int(v)
    except Exception:
        return 0


intents = discord.Intents.default()
bot = commands.Bot(command_prefix="!", intents=intents)


@bot.event
async def on_ready():
    print(f"[{_iso_now()}] Logged in as {bot.user}")


@bot.command(name="online")
async def cmd_online(ctx: commands.Context):
    """Show online users (last_seen_at in last 5 min)."""
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(minutes=5)
    online_users = _scalar(
        """
        SELECT COUNT(*) AS c
        FROM users
        WHERE last_seen_at IS NOT NULL
          AND last_seen_at >= ?
        """,
        (cutoff.isoformat(),),
    )
    await ctx.reply(f"👀 Online (last 5 min): **{online_users}**")


@bot.command(name="stats")
async def cmd_stats(ctx: commands.Context):
    """Show basic site stats."""
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    cutoff = now - timedelta(minutes=5)

    total_users = _scalar("SELECT COUNT(*) AS c FROM users")
    registered_today = _scalar(
        "SELECT COUNT(*) AS c FROM users WHERE created_at >= ?",
        (today_start.isoformat(),),
    )
    online_users = _scalar(
        """
        SELECT COUNT(*) AS c
        FROM users
        WHERE last_seen_at IS NOT NULL
          AND last_seen_at >= ?
        """,
        (cutoff.isoformat(),),
    )

    msg = (
        f"📊 **CHECKNE stats**\n"
        f"• Total users: **{total_users}**\n"
        f"• Registered today (UTC): **{registered_today}**\n"
        f"• Online (last 5 min): **{online_users}**"
    )
    await ctx.reply(msg)


def main():
    token = os.getenv("DISCORD_BOT_TOKEN", "").strip()
    if not token:
        raise SystemExit("Missing DISCORD_BOT_TOKEN")

    # Connect DB using the same mechanism as the API app.
    db.connect()
    bot.run(token)


if __name__ == "__main__":
    main()
