"""A minimal WebSocket client and a pass/fail tally, shared by the e2e scripts."""
import base64, json, os, socket, struct, time

# E2E_PORT points the scripts at a server other than the dev one on 8000 - a
# fresh daphne carrying code the long-running dev server predates, say.
HOST, PORT = '127.0.0.1', int(os.environ.get('E2E_PORT', '8000'))
results = []


class WS:
    def __init__(self, path, origin='http://127.0.0.1:4200'):
        self.s = socket.create_connection((HOST, PORT), timeout=8)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((f'GET {path} HTTP/1.1\r\nHost: {HOST}:{PORT}\r\nUpgrade: websocket\r\n'
                        f'Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n'
                        f'Sec-WebSocket-Version: 13\r\nOrigin: {origin}\r\n\r\n').encode())
        buf = b''
        while b'\r\n\r\n' not in buf:
            buf += self.s.recv(4096)
        head, self.buf = buf.split(b'\r\n\r\n', 1)
        assert b' 101 ' in head.split(b'\r\n')[0], head.split(b'\r\n')[0]
        self.seen = []

    def _frame(self, opcode, payload):
        mask = os.urandom(4)
        n = len(payload)
        hdr = struct.pack('!BB', 0x80 | opcode, 0x80 | n) if n < 126 else \
            struct.pack('!BBH', 0x80 | opcode, 0x80 | 126, n)
        self.s.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))

    def send(self, obj):
        self._frame(0x1, json.dumps(obj).encode())

    def _fill(self, n):
        while len(self.buf) < n:
            chunk = self.s.recv(65536)
            if not chunk:
                raise ConnectionError('closed')
            self.buf += chunk

    def recv(self):
        while True:
            self._fill(2)
            b1, b2 = self.buf[0], self.buf[1]
            length, off = b2 & 0x7F, 2
            if length == 126:
                self._fill(4); length = struct.unpack('!H', self.buf[2:4])[0]; off = 4
            elif length == 127:
                self._fill(10); length = struct.unpack('!Q', self.buf[2:10])[0]; off = 10
            self._fill(off + length)
            payload, self.buf = self.buf[off:off + length], self.buf[off + length:]
            op = b1 & 0x0F
            if op == 0x9:
                self._frame(0xA, payload); continue
            if op == 0x8:
                raise ConnectionError('server closed')
            if op == 0x1:
                msg = json.loads(payload)
                self.seen.append(msg)
                return msg

    def until(self, pred, what, seconds=8):
        end = time.time() + seconds
        while time.time() < end:
            self.s.settimeout(max(0.1, end - time.time()))
            try:
                m = self.recv()
            except socket.timeout:
                break
            if pred(m):
                return m
        raise AssertionError(f'never saw {what}')

    def type(self, t, seconds=8):
        return self.until(lambda m: m.get('type') == t, t, seconds)

    def drain(self, seconds):
        """Everything that arrives in the next `seconds`."""
        got, end = [], time.time() + seconds
        while time.time() < end:
            self.s.settimeout(max(0.05, end - time.time()))
            try:
                got.append(self.recv())
            except socket.timeout:
                break
        return got

    def close(self):
        try:
            self._frame(0x8, b'')
            self.s.close()
        except OSError:
            pass


def check(name, ok, detail=''):
    results.append(bool(ok))
    print(f'  {"PASS" if ok else "FAIL"}  {name}{"  -- " + str(detail)[:300] if detail and not ok else ""}', flush=True)


def step(name, fn):
    try:
        fn()
    except Exception as e:
        check(name, False, repr(e))
        return False
    return True
