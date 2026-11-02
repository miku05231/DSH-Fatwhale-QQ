from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit


MEDIA_TYPES = {"image", "record", "audio", "video", "file"}


def incoming_components(segments: list[dict[str, Any]], callback_client):
    from astrbot.core.message.components import At, AtAll, Face, File, Image, Plain, Record, Reply, Video

    result = []
    for segment in segments:
        kind = segment.get("type")
        data = segment.get("data") if isinstance(segment.get("data"), dict) else {}
        if kind == "text" and isinstance(data.get("text"), str):
            result.append(Plain(data["text"]))
        elif kind == "at":
            qq = str(data.get("qq", ""))
            result.append(AtAll() if qq == "all" else At(qq=qq))
        elif kind == "reply" and data.get("id") is not None:
            result.append(Reply(id=str(data["id"]), sender_id=str(data.get("sender_id", "0"))))
        elif kind in MEDIA_TYPES:
            value = data.get("url") or data.get("file")
            if not isinstance(value, str):
                continue
            parts = urlsplit(value)
            if value.startswith("astrbot-media://") or parts.scheme in {"http", "https", "base64"}:
                normalized = value
            else:
                try:
                    normalized = callback_client.read_local_base64(value, kind)
                except Exception:
                    continue
            if kind == "image":
                result.append(Image(file=normalized, url=normalized if normalized.startswith(("http://", "https://")) else ""))
            elif kind in {"record", "audio"}:
                result.append(Record(file=normalized, url=normalized if normalized.startswith(("http://", "https://")) else ""))
            elif kind == "video":
                result.append(Video(file=normalized, url=normalized if normalized.startswith(("http://", "https://")) else ""))
            else:
                result.append(File(file=normalized, name=str(data.get("name", "file"))))
        elif kind == "face" and data.get("id") is not None:
            result.append(Face(id=int(data["id"])))
    return result


async def outgoing_components(chain, callback_client) -> list[dict[str, Any]]:
    components = getattr(chain, "chain", None)
    if not isinstance(components, list):
        raise ValueError("AstrBot send requires a native MessageChain")
    result = []
    for component in components:
        segment = await component.to_dict()
        if not isinstance(segment, dict):
            raise ValueError("invalid AstrBot message component")
        kind = segment.get("type")
        if kind in MEDIA_TYPES:
            data = segment.get("data")
            if not isinstance(data, dict):
                raise ValueError("invalid AstrBot media component")
            value = data.get("url") or data.get("file") or data.get("path")
            if not isinstance(value, str) or not value:
                raise ValueError("AstrBot media component has no source")
            parts = urlsplit(value)
            if not (value.startswith("astrbot-media://") or parts.scheme in {"http", "https"}):
                data["file"] = await callback_client.materialize_local(value, kind)
                data.pop("url", None)
                data.pop("path", None)
        result.append(segment)
    return result
