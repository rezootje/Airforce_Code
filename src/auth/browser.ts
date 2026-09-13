import crossSpawn from 'cross-spawn';
export async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'rundll32.exe'
        : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const keys = [
    'PATH',
    'HOME',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'SystemRoot',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
    'XAUTHORITY',
  ];
  const env = Object.fromEntries(
    keys.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]!]),
  );
  await new Promise<void>((resolve, reject) => {
    const child = crossSpawn.spawn(command, args, {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
      env,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
