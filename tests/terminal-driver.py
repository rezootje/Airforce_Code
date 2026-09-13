"""Linux PTY smoke test. Only synthetic credentials are used."""
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
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 110, 0, 0))
child = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
transcript = b''

def wait_for(text):
    global transcript
    deadline = time.monotonic() + 12
    target = text.encode()
    while target not in transcript:
        if time.monotonic() > deadline:
            raise RuntimeError('Timed out waiting for ' + text + ': ' + transcript[-2500:].decode(errors='replace'))
        if select.select([master], [], [], 0.1)[0]:
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b''
            if not data:
                raise RuntimeError('CLI exited before ' + text + ': ' + transcript[-2500:].decode(errors='replace'))
            transcript += data
    transcript = transcript[transcript.index(target) + len(target):]

def send(value):
    os.write(master, value.encode())
    time.sleep(0.08)

try:
    wait_for('Authentication')
    send('\r')
    wait_for('API base URL')
    send(os.environ['AIRFORCE_BASE_URL'] + '\r')
    wait_for('API key')
    send('synthetic-pty-key\r')
    wait_for('Select a model')
    send('\r')
    wait_for('Default permission mode')
    send('\r')
    wait_for('Save API key')
    send('y\r')
    wait_for('Setup complete')
    child.wait(timeout=5)
    if child.returncode != 0:
        raise RuntimeError('Setup failed')
    print('PTY onboarding passed')
finally:
    if child.poll() is None:
        child.terminate()
        child.wait(timeout=5)
    os.close(master)
