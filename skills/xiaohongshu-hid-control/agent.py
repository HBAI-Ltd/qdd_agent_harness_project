#!/usr/bin/env python3
"""Closed-loop driver for the qdd-android-hid MCP (ESP32 BLE keyboard/mouse).

Why this exists
---------------
`android_control` can only place the pointer by *relative* deltas, and the
device renders the pointer into the screenshot. So the only trustworthy way to
reach a pixel is: park at a known anchor (pointer_home -> 0,0), nudge in small
steps, and read back where the pointer actually is from the image diff.
Large single deltas (>~130 HID counts) get accelerated ~2x by the phone's
pointer tuning, so every step here is capped at STEP_MAX.

CLI
---
  shot                       grab a frame
  status                     hid status
  home                       park the pointer at the top-left corner
  blob REF CUR               report changed blobs between two frames
  pos REF CUR                report the pointer position in CUR vs anchor REF
  goto X Y                   closed-loop move to pixel (X,Y)
  tap X Y                    goto + click
  click [count]              click at the current pointer position
  back | homekey             hardware back / home key
  key COMBO                  e.g. enter, escape, ctrl+a
  type TEXT                  US-layout ASCII
  scroll AMOUNT              signed wheel counts
  swipe X1 Y1 X2 Y2 [MS]     drag between pixels
"""
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections import deque

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(HERE, 'state.json')
SHOTS = os.path.join(HERE, 'shots')
os.makedirs(SHOTS, exist_ok=True)

ENDPOINT = os.environ.get('HID_MCP_URL', 'http://192.168.100.166:8792/mcp')
W, H = 1080, 2400
STEP_MAX = 120          # stay inside the 1:1 (non-accelerated) pointer regime
TOL = 6                 # px tolerance when homing in on a target
CURSOR_MIN_AREA = 150   # the pointer blob is ~700-3400 px
ANCHOR_NEAR = 45        # ignore blobs this close to (0,0) -- the anchor ghost


# ---------------------------------------------------------------- state / rpc
def load_state():
    try:
        with open(STATE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(st):
    with open(STATE, 'w', encoding='utf-8') as f:
        json.dump(st, f, indent=2)


_id = [0]


def rpc(method, params=None, notify=False):
    st = load_state()
    headers = {'Content-Type': 'application/json',
               'Accept': 'application/json, text/event-stream'}
    if st.get('sessionId'):
        headers['mcp-session-id'] = st['sessionId']
    body = {'jsonrpc': '2.0', 'method': method, 'params': params or {}}
    if not notify:
        _id[0] += 1
        body['id'] = _id[0]
    req = urllib.request.Request(ENDPOINT, data=json.dumps(body).encode('utf-8'),
                                 headers=headers, method='POST')
    with urllib.request.urlopen(req, timeout=60) as r:
        sid = r.headers.get('mcp-session-id')
        raw = r.read().decode('utf-8', 'replace').strip()
        ctype = r.headers.get('content-type') or ''
    if sid and sid != st.get('sessionId'):
        st['sessionId'] = sid
        save_state(st)
    if not raw:
        return None
    if 'text/event-stream' in ctype:
        datas = [l[5:].strip() for l in raw.splitlines() if l.startswith('data:')]
        raw = datas[-1] if datas else '{}'
    return json.loads(raw)


def ensure_session():
    if load_state().get('sessionId'):
        return
    rpc('initialize', {'protocolVersion': '2025-06-18', 'capabilities': {},
                       'clientInfo': {'name': 'xhs-agent', 'version': '1.0'}})
    rpc('notifications/initialized', {}, notify=True)


def tool(name, args=None):
    ensure_session()
    try:
        res = rpc('tools/call', {'name': name, 'arguments': args or {}})
    except (urllib.error.HTTPError, urllib.error.URLError):
        # A server restart or a device switch invalidates the stored session.
        st = load_state()
        st.pop('sessionId', None)
        save_state(st)
        ensure_session()
        res = rpc('tools/call', {'name': name, 'arguments': args or {}})
    if res is None:
        return None
    if 'error' in res:
        raise RuntimeError(f'{name}: {res["error"]}')
    return res.get('result') or {}


_seq = [0]


def _unique_path(label, ext='jpg'):
    """Second-resolution timestamps collide when two actions land in the same
    second, which silently makes a diff compare a file with itself."""
    while True:
        _seq[0] += 1
        ts = time.strftime('%H%M%S') + f'{int(time.time() * 1000) % 1000:03d}'
        p = os.path.join(SHOTS, f'{ts}-{label}-{_seq[0]}.{ext}')
        if not os.path.exists(p):
            return p


def _persist(result, label):
    paths = []
    for c in result.get('content') or []:
        if c.get('type') == 'image' and c.get('data'):
            ext = 'png' if 'png' in (c.get('mimeType') or '') else 'jpg'
            p = _unique_path(label, ext)
            with open(p, 'wb') as f:
                f.write(base64.b64decode(c['data']))
            paths.append(p)
    if paths:
        st = load_state()
        st['lastImage'] = paths[-1]
        st['lastImageTs'] = time.time()
        save_state(st)
    return paths


def shot():
    global W, H
    r = tool('android_screenshot')
    paths = _persist(r, 'shot')
    sc = r.get('structuredContent') or {}
    # The phone can be swapped between runs; never trust a hard-coded size.
    if sc.get('width'):
        W = int(sc['width'])
    if sc.get('height'):
        H = int(sc['height'])
    st = load_state()
    if sc.get('frameId'):
        st['lastFrameId'] = sc['frameId']
        save_state(st)
    return sc, (paths[-1] if paths else None)


def control(**kw):
    """One android_control step. Retries once with a fresh frame only when the
    action never started, so a duplicate action is never issued."""
    st = load_state()
    args = dict(kw)
    args.setdefault('frameId', st.get('lastFrameId'))
    for attempt in (0, 1):
        r = tool('android_control', args)
        sc = r.get('structuredContent') or {}
        msg = str(sc.get('message') or '')
        if 'expired' in msg.lower() and sc.get('actionStarted') is False and attempt == 0:
            fresh, _ = shot()
            if not fresh.get('frameId'):
                break
            args['frameId'] = fresh['frameId']
            continue
        paths = _persist(r, 'ctl-' + str(args.get('action', 'x')))
        sc = r.get('structuredContent') or {}
        if sc.get('frameId'):
            st = load_state()
            st['lastFrameId'] = sc['frameId']
            # A click leaves the cursor where it is; anything else (scroll, key,
            # navigation) makes the stored anchor frame stale.
            if args.get('action') == 'click':
                st['posImage'] = st.get('lastImage')
            elif args.get('action') != 'move':
                st['posImage'] = None
            save_state(st)
        return sc, (paths[-1] if paths else None)
    return {}, None


# ------------------------------------------------------------------- vision
def blobs(ref, cur, thr=16, min_area=25):
    A = np.asarray(Image.open(ref).convert('RGB'), dtype=np.int16)
    B = np.asarray(Image.open(cur).convert('RGB'), dtype=np.int16)
    if A.shape != B.shape:
        return []
    mask = np.abs(A - B).max(axis=2) > thr
    h, w = mask.shape
    m = mask.astype(np.int16)
    nb = np.zeros_like(m)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dx or dy:
                nb += np.roll(np.roll(m, dy, 0), dx, 1)
    core = mask & (nb >= 3)
    seen = np.zeros_like(mask)
    out = []
    ys, xs = np.nonzero(core)
    for y0, x0 in zip(ys, xs):
        if seen[y0, x0]:
            continue
        q = deque([(y0, x0)])
        seen[y0, x0] = True
        pts = []
        while q:
            y, x = q.popleft()
            pts.append((y, x))
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < h and 0 <= nx < w and core[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    q.append((ny, nx))
        if len(pts) >= min_area:
            py = [p[0] for p in pts]
            px = [p[1] for p in pts]
            x0b, y0b = min(px), min(py)
            out.append({'area': len(pts), 'x': x0b, 'y': y0b,
                        'w': max(px) - x0b + 1, 'h': max(py) - y0b + 1,
                        'cx': (min(px) + max(px)) // 2,
                        'cy': (min(py) + max(py)) // 2})
    return sorted(out, key=lambda b: -b['area'])


def _is_pointer(b):
    """The pointer is a near-circular ~66px disc. Content changes are not.

    Near a screen edge the disc is clipped, so the size floor is relaxed there.
    """
    touches_edge = (b['x'] <= 2 or b['y'] <= 2 or b['x'] + b['w'] >= W - 2
                    or b['y'] + b['h'] >= H - 2)
    lo = 18 if touches_edge else 45
    if not (lo <= b['w'] <= 95 and lo <= b['h'] <= 95):
        return False
    ar = b['w'] / max(1, b['h'])
    if not (0.55 <= ar <= 1.8):
        return False
    fill = b['area'] / max(1.0, b['w'] * b['h'])
    return 0.25 <= fill <= 0.98


def pointer_pos(ref, cur, expect=None):
    """Position of the pointer in `cur`, given `ref` holds it at the anchor.

    The pointer is a translucent grey disc, so its contrast drops sharply over
    a dimmed dialog scrim; and scrolling feed content adds large decoy blobs.
    Filter on pointer shape first, then relax the threshold.
    """
    for thr, min_area in ((16, 400), (8, 200), (5, 120)):
        cands = [b for b in blobs(ref, cur, thr=thr) if b['area'] >= min_area and _is_pointer(b)]
        if not cands:
            continue
        if expect is not None:
            # The anchor ghost sits at the origin; never mistake it for the
            # cursor when the cursor is expected somewhere else on screen.
            if abs(expect[0]) > 80 or abs(expect[1]) > 80:
                cands = [b for b in cands if not (b['cx'] < 26 and b['cy'] < 26)]
                if not cands:
                    continue
            near = [b for b in cands
                    if abs(b['cx'] - expect[0]) <= 400 and abs(b['cy'] - expect[1]) <= 400]
            if near:
                cands = near
            cands.sort(key=lambda b: (b['cx'] - expect[0]) ** 2 + (b['cy'] - expect[1]) ** 2)
            return (cands[0]['cx'], cands[0]['cy'])
        far = [b for b in cands if not (b['cx'] < ANCHOR_NEAR and b['cy'] < ANCHOR_NEAR)]
        if len(far) == 1:
            return (far[0]['cx'], far[0]['cy'])
        if len(cands) == 1:
            return (cands[0]['cx'], cands[0]['cy'])
    return None


def park():
    """pointer_home, then return a frame whose pointer sits at the (0,0) anchor."""
    shot()                                   # frameId is only valid ~30s
    tool('android_pointer_home', {'frameId': load_state()['lastFrameId']})
    _, img = shot()
    _save_pos((0, 0))
    return img


def _save_pos(pos, img=None):
    st = load_state()
    st['lastPos'] = [int(pos[0]), int(pos[1])]
    st['posImage'] = img if img is not None else st.get('lastImage')
    save_state(st)


def current_anchor(max_age=22.0):
    """Reuse the last measured pointer position instead of paying for pointer_home.

    Only valid when the reference frame is still the one the position was
    measured on: a scroll or navigation produces a new frame whose pointer may
    sit elsewhere, and reusing a stale (pos, frame) pair mis-reads the cursor.
    """
    st = load_state()
    img = st.get('lastImage')
    pos = st.get('lastPos')
    pos_img = st.get('posImage')
    age = time.time() - float(st.get('lastImageTs') or 0)
    if img and pos and img == pos_img and os.path.exists(img) and age <= max_age:
        return img, (int(pos[0]), int(pos[1]))
    return None, None


def _step(remaining, cap):
    """Step size for one axis.

    The phone accelerates deltas above ~130 HID counts (~2x), so the final
    approach always uses the guaranteed 1:1 cap. Long hauls may use a bigger
    step: even if the gain is 2x the overshoot is corrected by the next
    small-step iteration, so this cannot oscillate.
    """
    if abs(remaining) <= 0:
        return 0
    limit = cap * 2.5 if abs(remaining) > 500 else cap
    return int(max(-limit, min(limit, remaining)))


def gain():
    """Pixels per HID count for this device. Phones are 1:1; some tablets 2:1."""
    p = load_state().get('profile') or {}
    return float(p.get('gainX') or 1.0), float(p.get('gainY') or 1.0)


def set_gain(gx, gy=None):
    st = load_state()
    p = st.get('profile') or {}
    p['gainX'] = float(gx)
    p['gainY'] = float(gy if gy is not None else gx)
    st['profile'] = p
    save_state(st)
    return p


def blind_move(x, y, verbose=False):
    """Travel from the (0,0) anchor by arithmetic, without reading the pointer.

    Needed when the cursor is not captured or is drowned by a repainting video.
    Counts are derived from the measured pixel-per-count gain, and every step
    stays <=120 counts; correctness is confirmed by the click's effect.
    """
    gx, gy = gain()
    park()
    cx = cy = 0                      # pixels
    steps = 0
    while (abs(x - cx) > 2 or abs(y - cy) > 2) and steps < 40:
        dxp = int(max(-STEP_MAX * gx, min(STEP_MAX * gx, x - cx)))
        dyp = int(max(-STEP_MAX * gy, min(STEP_MAX * gy, y - cy)))
        control(action='move', dx=int(round(dxp / gx)), dy=int(round(dyp / gy)))
        cx += dxp
        cy += dyp
        steps += 1
        if verbose:
            print(f'  blind({dxp:+},{dyp:+})px -> ({cx},{cy})')
    _save_pos((cx, cy))
    return cx, cy


def goto(x, y, ref=None, verbose=True, deadline=45.0):
    """Closed-loop move to pixel (x,y). Returns (x, y, image, ref).

    ref='auto' reuses the last measured pointer position (2 fewer calls than a
    full pointer_home) and falls back to parking when that record is stale.

    Hard deadline: a failing detector used to re-park forever, which looked like
    a hang. Every path now exits within `deadline` seconds.
    """
    t0 = time.time()
    parks = 0
    x = max(0, min(W - 1, int(x)))
    y = max(0, min(H - 1, int(y)))
    if ref == 'auto':
        ref, pos = current_anchor()
        if ref is None:
            ref = park()
            pos = (0, 0)
        cur = load_state().get('lastImage')
    elif ref is None:
        ref = park()
        pos = (0, 0)
        cur = ref
    else:
        cur = load_state().get('lastImage')
        pos = pointer_pos(ref, cur)
        if pos is None:
            ref = park()
            pos, cur = (0, 0), ref
    misses = 0
    for _ in range(48):
        if time.time() - t0 > deadline:
            raise RuntimeError(f'goto timed out after {deadline}s at {pos} -> ({x},{y})')
        ex, ey = x - pos[0], y - pos[1]
        if abs(ex) <= TOL and abs(ey) <= TOL:
            break
        dx, dy = _step(ex, STEP_MAX), _step(ey, STEP_MAX)
        sc, cur = control(action='move', dx=dx, dy=dy)
        if cur is None:
            return pos[0], pos[1], None, ref
        expect = (pos[0] + dx, pos[1] + dy)
        newpos = pointer_pos(ref, cur, expect=expect)
        if newpos is None:
            parks += 1
            if parks > 2:
                raise RuntimeError(f'pointer not detectable at {pos} -> ({x},{y})')
            ref = park()
            cur = ref
            pos = (0, 0)
            continue
        if verbose:
            print(f'  move({dx:+},{dy:+}) -> pointer {newpos} (target {x},{y})')
        if newpos == pos and (dx or dy):
            misses += 1
            if misses >= 2:
                parks += 1
                if parks > 2:
                    raise RuntimeError(f'input swallowed repeatedly at {pos} -> ({x},{y})')
                ref = park()
                cur = ref
                pos = (0, 0)
                misses = 0
            continue
        misses = 0
        pos = newpos
    _save_pos(pos)
    return pos[0], pos[1], cur, ref


def lclick(hold_ms=70, count=1):
    """Press and release as two separate HID reports.

    android_control's `click` coalesces down+up into one report, which Android
    often discards (button state appears unchanged). Two reports with a real
    gap produce an unmistakable ACTION_DOWN / ACTION_UP pair.
    """
    imgs = []
    for _ in range(count):
        tool('android_mouse_move', {'dx': 0, 'dy': 0, 'buttons': 1})
        time.sleep(hold_ms / 1000.0)
        tool('android_mouse_move', {'dx': 0, 'dy': 0, 'buttons': 0})
        time.sleep(0.15)
    # Page transitions take longer than the click; shooting immediately makes a
    # successful click look like a lost one, which invites a duplicate click.
    time.sleep(0.55)
    _, img = shot()
    return img


def tap(x, y, ref='auto'):
    px, py, img, ref = goto(x, y, ref=ref)
    if abs(px - x) > 24 or abs(py - y) > 24:
        raise RuntimeError(f'tap target unreachable: wanted ({x},{y}) got ({px},{py})')
    return lclick(), img


# --------------------------------------------------------------------- main
def main(argv):
    cmd = argv[1] if len(argv) > 1 else 'help'
    a = argv[2:]

    if cmd == 'shot':
        sc, img = shot()
        print(json.dumps({k: sc.get(k) for k in ('frameId', 'width', 'height', 'capturedAt')}))
        print('IMAGE:', img)
    elif cmd == 'status':
        r = tool('android_hid_status')
        print(json.dumps(r.get('structuredContent') or {}, indent=1))
    elif cmd == 'home':
        img = park()
        print('IMAGE:', img)
    elif cmd == 'blob':
        for b in blobs(a[0], a[1]):
            print(f"area={b['area']:6d} box=({b['x']},{b['y']}) {b['w']}x{b['h']} center=({b['cx']},{b['cy']})")
    elif cmd == 'pos':
        print(pointer_pos(a[0], a[1]))
    elif cmd == 'goto':
        x, y, img, _ = goto(int(a[0]), int(a[1]))
        print(f'landed ({x},{y})')
        print('IMAGE:', img)
    elif cmd == 'tap':
        # `safe` forces a full pointer_home; default reuses the last position.
        img, _ = tap(int(a[0]), int(a[1]), ref=(None if 'safe' in a else 'auto'))
        print('IMAGE:', img)
    elif cmd == 'click':
        img = lclick(count=int(a[0]) if a else 1)
        print('IMAGE:', img)
    elif cmd in ('back', 'homekey'):
        sc, img = control(action='back' if cmd == 'back' else 'home')
        print(json.dumps({k: sc.get(k) for k in ('action', 'actionCompleted', 'observedAfterAction')}))
        # Navigation animates; a frame taken immediately shows the old page and
        # invites a duplicate press that pops one level too far.
        time.sleep(0.55)
        sc2, img2 = shot()
        print('IMAGE:', img2 or img)
    elif cmd == 'key':
        sc, img = control(action='key', combo=a[0])
        print('IMAGE:', img)
    elif cmd == 'type':
        sc, img = control(action='type', text=a[0])
        print('IMAGE:', img)
    elif cmd == 'scroll':
        sc, img = control(action='scroll', amount=int(a[0]))
        print('IMAGE:', img)
    elif cmd == 'swipe':
        ms = int(a[4]) if len(a) > 4 else 400
        px, py, cur, _ = goto(int(a[0]), int(a[1]), ref='auto')
        sc, img = control(action='swipe', x1=int(a[0]), y1=int(a[1]),
                          x2=int(a[2]), y2=int(a[3]), durationMs=ms)
        print('IMAGE:', img)
    elif cmd == 'cal':
        # pointer_home/tap refuse to run until the device reports a calibration.
        shot()
        sx = float(a[0]) if a else 1.0
        sy = float(a[1]) if len(a) > 1 else sx
        rot = int(a[2]) if len(a) > 2 else 0
        r = tool('android_calibrate_pointer',
                 {'frameId': load_state()['lastFrameId'],
                  'scaleX': sx, 'scaleY': sy, 'rotation': rot})
        print(json.dumps(r.get('structuredContent') or {}, indent=1))
    elif cmd == 'arm':
        print(json.dumps(tool('android_hid_arm').get('structuredContent') or {}, indent=1))
    elif cmd == 'move':
        sc, img = control(action='move', dx=int(a[0]), dy=int(a[1]) if len(a) > 1 else 0)
        print('IMAGE:', img)
    elif cmd == 'gain':
        print(json.dumps(set_gain(float(a[0]), float(a[1]) if len(a) > 1 else None), indent=1))
    elif cmd == 'blindswipe':
        # Gain-independent mouse liveness test: start from the clamped corner.
        blind_move(int(a[0]), int(a[1]))
        ms = int(a[4]) if len(a) > 4 else 500
        sc, img = control(action='swipe', x1=int(a[0]), y1=int(a[1]),
                          x2=int(a[2]), y2=int(a[3]), durationMs=ms)
        print('IMAGE:', img)
    elif cmd == 'blindtap':
        cx, cy = blind_move(int(a[0]), int(a[1]), verbose=True)
        print(f'blind landed ({cx},{cy}) -> clicking')
        print('IMAGE:', lclick())
    elif cmd == 'longpress':
        ms = int(a[2]) if len(a) > 2 else 900
        goto(int(a[0]), int(a[1]), ref=None)
        print('IMAGE:', lclick(hold_ms=ms))
    elif cmd == 'staleframe':
        # Prove the expired-frame branch: the action must NOT start.
        r = tool('android_control', {'action': a[0] if a else 'click',
                                     'frameId': '00000000-0000-0000-0000-000000000000'})
        print(json.dumps(r.get('structuredContent') or {}, indent=1, ensure_ascii=False))
    elif cmd == 'raw':
        r = tool(a[0], json.loads(a[1]) if len(a) > 1 else {})
        print(json.dumps(r.get('structuredContent') or {}, indent=1, ensure_ascii=False))
    else:
        print(__doc__)


if __name__ == '__main__':
    main(sys.argv)
