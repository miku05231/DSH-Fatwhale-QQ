from __future__ import annotations

import asyncio
import base64
import binascii
import ipaddress
import json
import socket
from functools import partial
from pathlib import Path
from urllib.parse import unquote, urlsplit

import aiohttp

from astrbot.core.agent.message import Message, is_checkpoint_message
from astrbot.core.provider.entities import LLMResponse, ToolCallsResult
from astrbot.core.provider.provider import Provider
from astrbot.core.provider.register import register_provider_adapter

from .callback import MAX_RPC_BYTES, NodeCallbackClient
from .context import AI_PRINCIPAL, bind_principal, current_principal, require_principal, reset_principal

MAX_IMAGE_BYTES = 2 * 1024 * 1024
MAX_IMAGE_TOTAL = 5 * 1024 * 1024
IMAGE_MIMES = {"image/png", "image/jpeg", "image/webp", "image/gif"}
_callback: NodeCallbackClient | None = None


def set_callback_client(client: NodeCallbackClient) -> None:
    global _callback
    _callback = client


def _image_mime(data: bytes, claimed: str | None = None) -> str:
    detected = None
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        detected = "image/png"
    elif data.startswith(b"\xff\xd8\xff"):
        detected = "image/jpeg"
    elif data.startswith((b"GIF87a", b"GIF89a")):
        detected = "image/gif"
    elif len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        detected = "image/webp"
    mime = claimed.lower().split(";", 1)[0] if claimed else detected
    if mime not in IMAGE_MIMES or (detected and mime != detected):
        raise ValueError("image MIME is outside the model host allowlist")
    return mime


async def _remote_image(url: str) -> tuple[bytes, str]:
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password:
        raise ValueError("invalid image URL")
    loop = asyncio.get_running_loop()
    records = await loop.getaddrinfo(parts.hostname, parts.port or (443 if parts.scheme == "https" else 80), type=socket.SOCK_STREAM)
    addresses = {record[4][0] for record in records}
    if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
        raise ValueError("image URL resolves to a non-public address")

    class PublicResolver(aiohttp.abc.AbstractResolver):
        async def resolve(self, host, port=0, family=socket.AF_INET):
            values = await aiohttp.resolver.DefaultResolver().resolve(host, port, family)
            if not values or any(not ipaddress.ip_address(item["host"]).is_global for item in values):
                raise OSError("image URL resolved to a non-public address")
            return values

        async def close(self):
            return None

    connector = aiohttp.TCPConnector(resolver=PublicResolver(), ttl_dns_cache=0)
    timeout = aiohttp.ClientTimeout(total=20, connect=5)
    async with aiohttp.ClientSession(connector=connector, timeout=timeout, trust_env=False) as session:
        async with session.get(url, allow_redirects=False) as response:
            if response.status != 200:
                raise ValueError("image URL request failed")
            mime = response.headers.get("Content-Type", "").split(";", 1)[0].lower()
            if mime not in IMAGE_MIMES:
                raise ValueError("image MIME is outside the model host allowlist")
            if int(response.headers.get("Content-Length", "0") or 0) > MAX_IMAGE_BYTES:
                raise ValueError("image exceeds the model image limit")
            data = await response.content.read(MAX_IMAGE_BYTES + 1)
            if len(data) > MAX_IMAGE_BYTES:
                raise ValueError("image exceeds the model image limit")
            return data, _image_mime(data, mime)


def _allowed_local_path(path: Path) -> bool:
    if _callback is None:
        return False
    resolved = path.resolve(strict=True)
    return any(resolved == root or root in resolved.parents for root in _callback.allowed_local_roots)

async def image_data_uri(reference: str) -> str:
    if reference.startswith("data:"):
        header, sep, payload = reference.partition(",")
        mime = header[5:].split(";", 1)[0].lower()
        if not sep or "base64" not in header or mime not in IMAGE_MIMES:
            raise ValueError("unsupported image data URI")
        if len(payload) > MAX_IMAGE_BYTES * 4 // 3 + 8:
            raise ValueError("image exceeds the model image limit")
        try:
            data = base64.b64decode(payload, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ValueError("invalid image data URI") from exc
        mime = _image_mime(data, mime)
    elif reference.startswith("base64://"):
        payload = reference[9:]
        if len(payload) > MAX_IMAGE_BYTES * 4 // 3 + 8:
            raise ValueError("image exceeds the model image limit")
        try:
            data = base64.b64decode(payload, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ValueError("invalid image base64") from exc
        mime = _image_mime(data)
    elif urlsplit(reference).scheme in {"http", "https"}:
        data, mime = await _remote_image(reference)
    else:
        parts = urlsplit(reference)
        path = Path(unquote(parts.path)) if parts.scheme == "file" else Path(reference)
        if not _allowed_local_path(path):
            raise ValueError("local image is outside AstrBot's event cache")
        if path.stat().st_size > MAX_IMAGE_BYTES:
            raise ValueError("image exceeds the model image limit")
        data = path.read_bytes()
        mime = _image_mime(data)
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise ValueError("image exceeds the model image limit")
    return "data:" + mime + ";base64," + base64.b64encode(data).decode("ascii")


async def _materialize_content(content):
    if isinstance(content, list):
        output = []
        for part in content:
            if not isinstance(part, dict):
                continue
            item = dict(part)
            if item.get("type") == "image_url":
                image = item.get("image_url")
                if isinstance(image, str):
                    item["image_url"] = {"url": await image_data_uri(image)}
                elif isinstance(image, dict) and isinstance(image.get("url"), str):
                    item["image_url"] = dict(image, url=await image_data_uri(image["url"]))
            output.append(item)
        return output
    return content


def _native_module_owner(module_path: str | None) -> str | None:
    if not isinstance(module_path, str) or not module_path:
        return None
    from astrbot.core.star.star_handler import star_map

    plugin = star_map.get(module_path)
    if plugin is None or getattr(plugin, "reserved", False) or not getattr(plugin, "activated", False):
        return None
    owner = getattr(plugin, "root_dir_name", None)
    return owner if isinstance(owner, str) and owner else None


def _native_tool_owner(tool) -> str | None:
    module_paths = []
    registered_path = getattr(tool, "handler_module_path", None)
    if isinstance(registered_path, str) and registered_path:
        module_paths.append(registered_path)

    handler = getattr(tool, "handler", None)
    seen = set()
    while handler is not None and id(handler) not in seen:
        seen.add(id(handler))
        if isinstance(handler, partial):
            handler = handler.func
            continue
        module_path = getattr(handler, "__module__", None)
        if isinstance(module_path, str):
            module_paths.append(module_path)
        wrapped = getattr(handler, "__wrapped__", None)
        if wrapped is None:
            break
        handler = wrapped

    tool_type = type(tool)
    type_module = getattr(tool_type, "__module__", None)
    if isinstance(type_module, str):
        module_paths.append(type_module)
    call_module = getattr(getattr(tool_type, "call", None), "__module__", None)
    if isinstance(call_module, str):
        module_paths.append(call_module)

    for module_path in dict.fromkeys(module_paths):
        owner = _native_module_owner(module_path)
        if owner is not None:
            return owner
    return None


def _admin_only_tool(tool) -> bool:
    sources = [tool, type(tool), getattr(type(tool), "call", None)]
    handler = getattr(tool, "handler", None)
    seen = set()
    while handler is not None and id(handler) not in seen:
        seen.add(id(handler))
        if isinstance(handler, partial):
            handler = handler.func
            continue
        sources.append(handler)
        wrapped = getattr(handler, "__wrapped__", None)
        if wrapped is None:
            break
        handler = wrapped

    for source in sources:
        if source is None:
            continue
        for attr in ("admin_only", "requires_admin", "permission", "permission_type"):
            value = getattr(source, attr, None)
            if (
                value is True
                or str(value).strip().upper() == "ADMIN"
                or getattr(value, "name", "").upper() == "ADMIN"
                or str(value).upper().endswith(".ADMIN")
            ):
                return True
    return False


def _native_tool_permissions_allowed(tool, event) -> bool:
    """Apply native PermissionTypeFilter metadata with its exact event semantics."""
    try:
        from astrbot.core import astrbot_config
        from astrbot.core.star.filter.permission import (
            COMMAND_PERMISSION_TYPES,
            PermissionType,
            PermissionTypeFilter,
        )
    except ImportError:
        return True

    sources = [tool, type(tool), getattr(type(tool), "call", None)]
    handler = getattr(tool, "handler", None)
    seen = set()
    while handler is not None and id(handler) not in seen:
        seen.add(id(handler))
        if isinstance(handler, partial):
            handler = handler.func
            continue
        sources.append(handler)
        wrapped = getattr(handler, "__wrapped__", None)
        if wrapped is None:
            break
        handler = wrapped

    filters = {}
    for source in sources:
        if source is None:
            continue
        for filter_ in getattr(source, "event_filters", ()) or ():
            if isinstance(filter_, PermissionTypeFilter):
                filters[id(filter_)] = filter_
        permission = getattr(source, "permission_type", None)
        if isinstance(permission, str):
            permission = COMMAND_PERMISSION_TYPES.get(permission.strip().lower())
        if isinstance(permission, PermissionType):
            filter_ = PermissionTypeFilter(permission, raise_error=False)
            filters[(id(source), permission)] = filter_

    if not filters:
        return True
    if event is None:
        return False
    try:
        return all(filter_.filter(event, astrbot_config) for filter_ in filters.values())
    except Exception:
        return False


@register_provider_adapter(
    "qq_astrbot_node",
    "Node authenticated model callback for qq-bridge",
    default_config_tmpl={"type": "qq_astrbot_node", "enable": True, "id": "qq_astrbot_node", "key": [""], "model": "dsh-selected"},
    provider_display_name="qq-bridge model callback",
)
class NodeBackedProvider(Provider):
    def __init__(self, provider_config: dict, provider_settings: dict):
        super().__init__(provider_config, provider_settings)
        if _callback is None:
            raise RuntimeError("Node callback client was not installed")
        self.callback = _callback

    def get_current_key(self) -> str:
        return "node-callback"

    def set_key(self, key: str) -> None:
        if key != "node-callback":
            raise ValueError("the Node callback adapter has no local API key")

    async def get_models(self) -> list[str]:
        return ["dsh-selected"]

    async def text_chat(
        self,
        prompt=None,
        session_id=None,
        image_urls=None,
        audio_urls=None,
        func_tool=None,
        contexts=None,
        system_prompt=None,
        tool_calls_result=None,
        model=None,
        extra_user_content_parts=None,
        tool_choice="auto",
        request_max_retries=None,
        **kwargs,
    ) -> LLMResponse:
        actor = current_principal.get()
        temporary_token = None
        event = None
        if actor is None:
            from astrbot.core.platform.astr_message_event import current_message_event
            event = current_message_event.get(None)
            identity = getattr(event, "identity", None)
            if not getattr(event, "_qq_bridge_event", False) or identity is None or not identity.allow_ai:
                raise PermissionError("Node-authorized AI identity is unavailable")
            temporary_token = bind_principal(identity, AI_PRINCIPAL)
            actor = require_principal()
        try:
            if event is None:
                from astrbot.core.platform.astr_message_event import current_message_event
                event = current_message_event.get(None)
            event_identity = getattr(event, "identity", None)
            if getattr(event, "_qq_bridge_event", False) and event_identity != actor.identity:
                raise PermissionError("Node-authorized AI identity does not match the active event")
            messages = []
            if system_prompt:
                messages.append({"role": "system", "content": system_prompt})
            for message in contexts or []:
                if is_checkpoint_message(message):
                    continue
                item = message.model_dump() if isinstance(message, Message) else dict(message)
                item["content"] = await _materialize_content(item.get("content"))
                messages.append(item)
            content_parts = []
            if prompt is not None:
                content_parts.append({"type": "text", "text": str(prompt)})
            images = list(image_urls or [])
            if len(images) > 6:
                raise ValueError("too many model images")
            total = 0
            for reference in images:
                uri = await image_data_uri(str(reference))
                encoded = uri.split(",", 1)[1]
                total += len(encoded) * 3 // 4
                if total > MAX_IMAGE_TOTAL:
                    raise ValueError("combined model image limit exceeded")
                content_parts.append({"type": "image_url", "image_url": {"url": uri}})
            for part in extra_user_content_parts or []:
                value = part.model_dump() if hasattr(part, "model_dump") else dict(part)
                if value.get("type") == "image_url":
                    image = value.get("image_url")
                    ref = image.get("url") if isinstance(image, dict) else image
                    value["image_url"] = {"url": await image_data_uri(ref)}
                content_parts.append(value)
            if content_parts:
                messages.append({"role": "user", "content": content_parts})
            results = tool_calls_result if isinstance(tool_calls_result, list) else ([tool_calls_result] if tool_calls_result else [])
            for item in results:
                messages.extend(item.to_openai_messages())
            tools = []
            if func_tool and not func_tool.empty():
                for schema in func_tool.openai_schema():
                    name = schema.get("function", {}).get("name")
                    tool = func_tool.get_tool(name) if isinstance(name, str) else None
                    owner = _native_tool_owner(tool) if tool is not None else None
                    if owner is None or owner not in actor.identity.plugin_ids:
                        continue
                    if actor.plugin_id != AI_PRINCIPAL and owner != actor.plugin_id:
                        continue
                    if _admin_only_tool(tool) and not actor.identity.is_admin:
                        continue
                    if not _native_tool_permissions_allowed(tool, event):
                        continue
                    owner_token = None
                    try:
                        owner_token = bind_principal(actor.identity, owner)
                        if await self.callback.authorize_tool(name, record_use=False):
                            tools.append(schema)
                    except PermissionError:
                        continue
                    finally:
                        if owner_token is not None:
                            reset_principal(owner_token)
            if len(json.dumps(messages, ensure_ascii=False).encode("utf-8")) > MAX_RPC_BYTES:
                raise ValueError("model request exceeds the bridge limit")
            payload = {"messages": messages, "tools": tools}
            if model:
                payload["model"] = model
            result = await self.callback.call("llm", payload, actor)
            if actor.plugin_id != AI_PRINCIPAL and getattr(event, "identity", None) == actor.identity:
                mark_claim = getattr(event, "_qq_mark_plugin_claim", None)
                if callable(mark_claim):
                    mark_claim()
            if not isinstance(result, dict):
                raise RuntimeError("Node model callback returned an invalid response")
            choices = result.get("choices")
            if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
                raise RuntimeError("Node model callback returned no choices")
            answer = choices[0].get("message")
            if not isinstance(answer, dict):
                raise RuntimeError("Node model callback returned an invalid message")
            calls = answer.get("tool_calls") or []
            names, args, ids = [], [], []
            for call in calls:
                if not isinstance(call, dict) or not isinstance(call.get("function"), dict):
                    raise RuntimeError("Node model callback returned an invalid tool call")
                call_id = call.get("id")
                function = call["function"]
                name = function.get("name")
                raw_args = function.get("arguments", "{}")
                parsed_args = raw_args if isinstance(raw_args, dict) else json.loads(raw_args)
                if not isinstance(call_id, str) or not isinstance(name, str) or not isinstance(parsed_args, dict):
                    raise RuntimeError("Node model callback returned an invalid tool call")
                names.append(name)
                args.append(parsed_args)
                ids.append(call_id)
            return LLMResponse(
                role="assistant",
                completion_text=answer.get("content") or "",
                tools_call_args=args,
                tools_call_name=names,
                tools_call_ids=ids,
                id=result.get("id"),
            )
        finally:
            if temporary_token is not None:
                reset_principal(temporary_token)
