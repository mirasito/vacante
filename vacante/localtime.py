"""Время Казахстана: с 1 марта 2024 года вся страна живёт по UTC+5 круглый год, без летнего времени."""

from datetime import timedelta, timezone

LOCAL = timezone(timedelta(hours=5))
