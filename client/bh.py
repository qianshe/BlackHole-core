#!/usr/bin/env python3
# BlackHole CLI — lets a website's code sandbox (bash/python) drive the local
# BlackHole MCP server directly over Streamable HTTP. Zero dependencies.
#
# BlackHole may expose this source to a remote sandbox as a recommended MCP client.
# Review the file before use. A served copy carries the MCP endpoint; legacy
# downloads with ?sessionid=<id> may also carry the session id. Injected values
# win over BH_URL/BH_SESSIONID; explicit --url/--sessionid flags override them.
# Read guide first, then follow it for workspace work.
#
# Usage:
#   python3 bh.py call guide                     # common operating manual
#   python3 bh.py tools                          # list the tools
#   python3 bh.py tools editor                   # show one tool's usage schema
#   python3 bh.py call exec '{"command":"git status"}'
#   python3 bh.py call editor - <<'JSON'          # complex args from stdin
#   {"path":"src/example.ts","operation":{"command":"view"}}
#   JSON
#   python3 bh.py ask                            # the operator prompt
#
# Escape-free shell commands — `sh` reads the command body from stdin, so no
# bash/JSON quoting at all; with a quoted heredoc delimiter bash expands
# nothing ('$', backticks, backslashes, single quotes pass through raw):
#   python3 bh.py sh exec - <<'EOF'  # PowerShell example; check the host schema
#   Get-ChildItem 'C:\temp' | Where-Object { $_.Length -gt 1MB }
#   EOF
# Short one-liners can stay on argv (still one quoting layer — bash's — but
# no JSON escaping; use double quotes around the whole command):
#   python3 bh.py sh exec "git status"
# exec is the single finite-command entry; `tools` reports the daemon-selected
# shell syntax and state semantics for the current operating system.
#
# Long finite builds may need a larger client request deadline, for example:
#   python3 bh.py --timeout 600 call exec '{"command":"npm run build"}'
# Background servers/watch use process start, then status by processId, not a
# larger finite timeout. Extra usage is available through guide {"tool":"process"}.
# A lost response does not prove that the command failed; verify before retrying.
#
# Config: BH_URL env var or --url <https://.../mcp/<token>>, plus BH_SESSIONID
#   or --sessionid <numeric session id>. Every work-tool call carries the id
#   automatically as its `sessionId` argument — never edit it. The id selects
#   which workspace a call touches; cwd persists across finite calls. Variables
#   persist only when the tool declares a persistent shell. On credential rotation,
#   the old id stops resolving — ask them for the new one.
# Round trips: the daemon maps the session id onto a warm MCP connection, so a
#   `call` is usually ONE round trip. The first call (or after 30 idle minutes)
#   transparently falls back to a full handshake and retries once. No resident
#   process, no state on disk — every invocation is independent.

import http.client
import json
import os
import sys
import urllib.error
import urllib.request


HELP = """BlackHole sandbox client
Usage:
  python3 bh.py call guide
  python3 bh.py tools [tool-name]
  python3 bh.py call <tool-name> ['<json-object>'|-]
  python3 bh.py sh <tool-name> <command|->
  python3 bh.py ask
"""
PROTO = '2025-06-18'
_negotiated = None

# Filled in by the daemon when it serves this script over /bh.py (leave empty in
# the source file). BH_URL points at this machine's MCP endpoint; the numeric
# session id is injected only when the script is downloaded with
# ?sessionid=<id>. Explicit --url/--sessionid flags win over these; the
# BH_URL/BH_SESSIONID env vars are only a fallback for a copy without them.
_INJECTED_URL = ''
_INJECTED_SESSIONID = ''


def _post(url, payload, session=None, timeout=180):
    headers = {
        'Accept': 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        # Python-urllib's default UA is blocked by Cloudflare Browser
        # Integrity Check on custom domains (Error 1010); an honest custom
        # UA passes. Sites behind other bot filters benefit too.
        'User-Agent': 'blackhole-cli/1.0',
    }
    if session:
        headers['Mcp-Session-Id'] = session
        if _negotiated:
            headers['MCP-Protocol-Version'] = _negotiated
    data = json.dumps(payload).encode('utf-8') if payload is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method='POST')
    try:
        resp = urllib.request.urlopen(req, timeout=timeout)
        return resp.status, resp.headers, resp.read()
    except urllib.error.HTTPError as e:
        # A 4xx carrying a JSON-RPC error body is a PROTOCOL answer (e.g.
        # -32000 not-initialized on a bare call), not a transport failure:
        # hand it back so the caller can classify and fall back.
        return e.code, e.headers, e.read()
    except urllib.error.URLError as e:
        raise SystemExit('cannot reach %s: %s' % (url, e.reason))


def _parse(headers, raw):
    """Handle both plain-JSON and SSE (text/event-stream) responses."""
    ct = headers.get('Content-Type') or ''
    if 'application/json' in ct:
        return json.loads(raw.decode('utf-8')) if raw.strip() else None
    if 'text/event-stream' in ct:
        fallback = None
        for frame in raw.decode('utf-8', 'replace').split('\n\n'):
            data = '\n'.join(l[5:] for l in frame.split('\n') if l.startswith('data:'))
            if not data:
                continue
            try:
                obj = json.loads(data)
            except ValueError:
                continue
            if obj.get('id') is not None:
                return obj
            fallback = fallback or obj
        return fallback
    return None


def _initialize(url, timeout, client='bh-cli'):
    """initialize + initialized on a fresh connection; returns the session id."""
    global _negotiated
    init = {
        'jsonrpc': '2.0', 'id': 0, 'method': 'initialize',
        'params': {
            'protocolVersion': PROTO,
            'capabilities': {},
            'clientInfo': {'name': client, 'version': '1.0.0'},
        },
    }
    st, hdrs, raw = _post(url, init, timeout=timeout)
    if st != 200:
        raise SystemExit('initialize failed: HTTP %s' % st)
    sid = hdrs.get('Mcp-Session-Id')
    hello = _parse(hdrs, raw)
    if isinstance(hello, dict) and isinstance(hello.get('result'), dict):
        _negotiated = hello['result'].get('protocolVersion') or _negotiated
    _post(url, {'jsonrpc': '2.0', 'method': 'notifications/initialized'}, session=sid, timeout=timeout)
    return sid


def _uninitialized(resp):
    """True when the server answered 'no handshake yet' (JSON-RPC -32000/-32002)."""
    if not isinstance(resp, dict):
        return False
    err = resp.get('error') or {}
    if err.get('code') in (-32000, -32002):
        return True
    return 'not initialized' in str(err.get('message') or '').lower()


def _post_parsed(url, payload, timeout, session=None):
    """POST and parse, retrying read-only calls when a middlebox truncates the
    first response (seen on tunnels). tools/call never retries: the side effect
    may already have happened."""
    method = payload.get('method')
    readonly = method in ('tools/list', 'prompts/get', 'resources/list', 'resources/read')
    attempts = 3 if readonly else 1
    resp, st, ct = None, 0, ''
    for attempt in range(attempts):
        try:
            st, hdrs, raw = _post(url, payload, session=session, timeout=timeout)
            ct = hdrs.get('Content-Type') or ''
            resp = _parse(hdrs, raw)
            if resp is not None:
                break
        except (urllib.error.URLError, ConnectionError, http.client.IncompleteRead) as e:
            st, ct = 0, type(e).__name__
            if attempt == attempts - 1:
                break
    if resp is None:
        raise SystemExit('empty response (HTTP %s, ct=%s)' % (st, ct))
    return resp


def _result_or_die(resp):
    if isinstance(resp, dict) and 'error' in resp:
        raise SystemExit('MCP error %s: %s' % (resp['error'].get('code'), resp['error'].get('message')))
    return resp.get('result') if isinstance(resp, dict) else None


def _rpc(url, method, params=None, timeout=180):
    """Bare call first, full handshake only as fallback.

    The daemon maps the numeric sessionId argument onto a warm MCP connection,
    so a bare POST (no session header) usually lands in one round trip. When
    the server has no warm pair for us yet it answers not-initialized; we then
    run the full initialize handshake and retry the call once. Sessions are
    never DELETEd here — the server reaps idle ones, and the warm pair is
    exactly what makes the next bare call fast.
    """
    payload = {'jsonrpc': '2.0', 'id': 1, 'method': method}
    if params is not None:
        payload['params'] = params
    resp = _post_parsed(url, payload, timeout)
    if not _uninitialized(resp):
        return _result_or_die(resp)
    sid = _initialize(url, timeout)
    resp = _post_parsed(url, payload, timeout, session=sid)
    return _result_or_die(resp)


# Reference tools remain callable without a session id, but carry one when it
# is available so their calls appear on the session timeline.
_KEYLESS = ('guide', 'skill')


def _call_tool(url, sessionid, timeout, name, params):
    """Shared body of `call`/`sh`: inject the session id, run, print, exit code."""
    if not sessionid and name not in _KEYLESS:
        raise SystemExit('call needs your session id: set BH_SESSIONID or pass --sessionid')
    if sessionid:
        params = dict(params or {})
        params['sessionId'] = sessionid
    r = _rpc(url, 'tools/call', {'name': name, 'arguments': params}, timeout=timeout)
    printed = False
    for c in (r or {}).get('content', []):
        if c.get('type') == 'text':
            print(c.get('text', ''))
            printed = True
    if not printed and isinstance(r, dict) and r.get('structuredContent') is not None:
        print(json.dumps(r['structuredContent'], ensure_ascii=False, indent=2))
    if (r or {}).get('isError'):
        sys.exit(1)


def _read_stdin():
    """stdin as strict UTF-8: a bad byte stops with a message, not a traceback."""
    try:
        return sys.stdin.read()
    except UnicodeDecodeError as e:
        raise SystemExit('stdin is not valid UTF-8 (byte %d): send the JSON/command as UTF-8' % e.start)


def main():
    # Sandboxes pass JSON as UTF-8. Windows Python may otherwise decode stdin
    # with a legacy codepage; keep output UTF-8 too so tool text cannot crash.
    try:
        sys.stdin.reconfigure(encoding='utf-8', errors='strict')
    except Exception:
        pass
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass
    args = sys.argv[1:]
    url = None
    sessionid = None
    timeout = None
    while args and args[0] in ('--url', '--sessionid', '--timeout') and len(args) > 1:
        if args[0] == '--url':
            url, args = args[1], args[2:]
        elif args[0] == '--sessionid':
            sessionid, args = args[1], args[2:]
        else:
            timeout, args = float(args[1]), args[2:]
    url = url or _INJECTED_URL or os.environ.get('BH_URL') or None
    if not url:
        raise SystemExit('set BH_URL (https://<tunnel>/mcp/<token>) or pass --url')
    sessionid = sessionid or _INJECTED_SESSIONID or os.environ.get('BH_SESSIONID') or None
    timeout = timeout or float(os.environ.get('BH_TIMEOUT') or 180)
    if not args:
        print(HELP)
        return
    cmd = args[0]

    if cmd == 'tools':
        if len(args) > 2:
            raise SystemExit('usage: tools [tool-name]')
        r = _rpc(url, 'tools/list', {}, timeout=timeout)
        tools = (r or {}).get('tools', [])
        if len(args) == 2:
            found = next((t for t in tools if t.get('name') == args[1]), None)
            if found is None:
                raise SystemExit('unknown tool: %s (run tools to list available names)' % args[1])
            usage = {k: found[k] for k in ('name', 'description', 'inputSchema') if k in found}
            print(json.dumps(usage, ensure_ascii=False, indent=2))
        else:
            for t in tools:
                print('%s - %s' % (t['name'], (t.get('description') or '').split('\n')[0]))
    elif cmd == 'ask':
        r = _rpc(url, 'prompts/get', {'name': 'blackhole_operator'}, timeout=timeout)
        for m in (r or {}).get('messages', []):
            c = m.get('content', {})
            if c.get('type') == 'text':
                print(c.get('text', ''))
    elif cmd == 'call':
        if len(args) < 2 or len(args) > 3:
            raise SystemExit("usage: call <tool-name> ['<json-args>'|-]")
        raw = '{}' if len(args) == 2 else (_read_stdin() if args[2] == '-' else args[2])
        if not raw.strip():
            raise SystemExit('args JSON is empty')
        try:
            params = json.loads(raw)
        except ValueError as e:
            raise SystemExit('args must be valid JSON: %s' % e)
        if not isinstance(params, dict):
            raise SystemExit('args must be a JSON object')
        _call_tool(url, sessionid, timeout, args[1], params)
    elif cmd == 'sh':
        # `sh <tool> -` reads the command from stdin (pair with <<'EOF' in
        # bash for zero escaping); `sh <tool> <command...>` joins argv. The
        # use `exec`; its tool metadata declares the current shell syntax.
        rest = args[1:]
        if not rest:
            raise SystemExit("usage: sh <tool> -  (command on stdin, use <<'EOF')\n"
                             "       sh <tool> <command...>")
        tool, rest = rest[0], rest[1:]
        if rest and rest[0] == '-':
            command = _read_stdin()
        else:
            command = ' '.join(rest)
        if not command.strip():
            raise SystemExit('sh: empty command')
        _call_tool(url, sessionid, timeout, tool, {'command': command})
    else:
        raise SystemExit('unknown command: %s (tools|ask|call|sh)' % cmd)


if __name__ == '__main__':
    main()
