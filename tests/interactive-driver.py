"""Linux PTY smoke test for directory consent and the live slash palette."""
import json
import os
import pty
import select
import struct
import subprocess
import sys
import termios
import fcntl
import time

command = json.loads(sys.argv[1])
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 38, 110, 0, 0))
child = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
transcript = b''

def wait_for(text):
    global transcript
    deadline = time.monotonic() + 12
    target = text.encode()
    while target not in transcript:
        if time.monotonic() > deadline:
            raise RuntimeError('Timed out waiting for ' + text + ': ' + transcript[-3000:].decode(errors='replace'))
        if select.select([master], [], [], 0.1)[0]:
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b''
            if not data:
                raise RuntimeError('CLI exited before ' + text + ': ' + transcript[-3000:].decode(errors='replace'))
            transcript += data
    transcript = transcript[transcript.index(target) + len(target):]

def send(value):
    os.write(master, value)
    time.sleep(0.1)

try:
    wait_for('Directory access')
    send(b'\r')
    wait_for('Workspace')
    send(b'/')
    wait_for('Commands')
    send(b'mod')
    wait_for('Search/select models')
    send(b'\x03')
    send(b'wait for escape\r')
    wait_for('Esc to interrupt')
    send(b'\x1b')
    wait_for('ESC_INTERRUPT')
    wait_for('/ commands')
    send(b'\x03')
    child.wait(timeout=8)
    if child.returncode != 0:
        raise RuntimeError('Interactive session failed')
    print('PTY interactive UI passed')
finally:
    if child.poll() is None:
        child.terminate()
        child.wait(timeout=5)
    os.close(master)
