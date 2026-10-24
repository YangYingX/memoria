"""Run the pinned original MCP server with its SDK transport bound to one local broker."""
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import runpy
import socket
import sys
import threading
import urllib.request


def main():
    script = Path(sys.argv[1]).resolve(strict=True)
    port = int(os.environ["MEMORIA_BILI_BROKER_PORT"])
    token = os.environ["MEMORIA_BILI_BROKER_TOKEN"]
    if script.parent != Path.cwd().resolve() or not 1 <= port <= 65535 or len(token) != 64:
        raise ValueError("INVALID_START")
    if hashlib.sha256(script.read_bytes()).hexdigest() != "06d077b95fd12b26802545c4dc690fff81a651c86f53c57c911f22516ee6dd51":
        raise ValueError("PACKAGE_MISMATCH")
    if (importlib.metadata.version("bilibili-api-python") != "17.4.2"
            or importlib.metadata.version("mcp") != "1.26.0"
            or importlib.metadata.version("httpx") != "0.28.1"):
        raise ValueError("DEPENDENCY_MISMATCH")

    # Application-level transport restriction, not an operating-system sandbox.
    connect = socket.socket.connect
    socketpair = socket.socketpair
    getaddrinfo = socket.getaddrinfo
    local = threading.local()
    def checked_socketpair(*args, **kwargs):
        # Windows asyncio implements its own wake-up pipe using the stdlib's
        # loopback socketpair fallback. Only that internal call may connect elsewhere locally.
        local.socketpair = True
        try:
            return socketpair(*args, **kwargs)
        finally:
            local.socketpair = False
    def checked_connect(connection, address):
        if not isinstance(address, tuple) or (address[:2] != ("127.0.0.1", port)
                and not (getattr(local, "socketpair", False) and address[0] == "127.0.0.1")):
            raise PermissionError("NETWORK_DISABLED")
        return connect(connection, address)
    def checked_getaddrinfo(host, target_port, *args, **kwargs):
        if host != "127.0.0.1" or int(target_port) != port:
            raise PermissionError("NETWORK_DISABLED")
        return getaddrinfo(host, target_port, *args, **kwargs)
    socket.socketpair = checked_socketpair
    socket.socket.connect = checked_connect
    socket.socket.connect_ex = checked_connect
    socket.getaddrinfo = checked_getaddrinfo
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")

    from bilibili_api import request_settings
    from bilibili_api.clients.HTTPXClient import HTTPXClient
    from bilibili_api.utils.network import BiliAPIResponse, register_client, select_client, request_log

    class MemoriaClient(HTTPXClient):
        async def request(self, method="", url="", params=None, data=None, files=None, **_):
            if files or not isinstance(params or {}, dict):
                raise PermissionError("NETWORK_DISABLED")
            json_body = isinstance(data, str)
            if json_body:
                if method != "POST" or url != "https://api.bilibili.com/x/dynamic/feed/create/dyn" or len(data) > 10000:
                    raise PermissionError("NETWORK_DISABLED")
                data = json.loads(data)
            if not isinstance(data or {}, dict):
                raise PermissionError("NETWORK_DISABLED")
            payload = {"method": method, "url": url,
                       "params": {str(k): str(v) for k, v in (params or {}).items()},
                       "data": data if json_body else {str(k): str(v) for k, v in (data or {}).items()},
                       **({"json": True} if json_body else {})}
            raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            if len(raw) > 16384:
                raise ValueError("REQUEST_TOO_LARGE")
            request = urllib.request.Request(f"http://127.0.0.1:{port}/network", data=raw,
                headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"}, method="POST")
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(request, timeout=25) as response:
                encoded = response.read(2 * 1024 * 1024 + 1)
            if len(encoded) > 2 * 1024 * 1024:
                raise ValueError("RESPONSE_TOO_LARGE")
            result = json.loads(encoded)
            if result.get("error"):
                raise PermissionError("BROKER_REFUSED")
            return BiliAPIResponse(code=result["status"], headers={"content-type": "application/json"},
                cookies={}, raw=json.dumps(result["body"], ensure_ascii=False).encode("utf-8"), url=url)

    register_client("memoria", MemoriaClient)
    select_client("memoria")
    request_settings.set_trust_env(False)
    request_settings.set_enable_auto_buvid(False)
    request_settings.set_enable_bili_ticket(False)
    request_settings.set_wbi_retry_times(1)
    request_log.set_on(False)
    os.environ["BILI_MCP_TOOLS"] = "bili_received_replies,bili_received_at_and_likes,bili_reply,bili_send_dynamic"
    namespace = runpy.run_path(str(script), run_name="memoria_bili_server")
    if os.environ.get("MEMORIA_BILI_DYNAMIC_REPLY") == "1":
        from bilibili_api import comment
        import re

        @namespace["mcp"].tool(name="memoria_reply_dynamic")
        async def memoria_reply_dynamic(oid: str, resource_type: int, text: str, rpid: str, root: str) -> str:
            if resource_type not in (11, 17) or not all(re.fullmatch(r"[1-9]\d{0,19}", value) for value in (oid, rpid)):
                raise ValueError("INVALID_DYNAMIC_REPLY")
            if not re.fullmatch(r"(?:0|[1-9]\d{0,19})", root) or not text.strip() or len(text) > 600:
                raise ValueError("INVALID_DYNAMIC_REPLY")
            result = await comment.send_comment(text=text, oid=int(oid), type_=comment.CommentResourceType(resource_type),
                root=int(rpid if root == "0" else root), parent=int(rpid), credential=namespace["get_cred"]())
            receipt = result.get("rpid_str") or result.get("rpid")
            return json.dumps({"success": True, "rpid": str(receipt)}, ensure_ascii=False)
    namespace["mcp"].run(transport="stdio")


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        # No upstream exception, request, credential or path crosses stderr.
        print("BILI_MCP_FAILED", file=sys.stderr)
        sys.exit(1)
