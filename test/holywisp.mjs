// Shared by the end-to-end tests: a free loopback port, and a real holyWisp on it with the dev
// policy (loopback and literal-IP destinations allowed: safe only because it binds 127.0.0.1).
import net from "node:net";
import { spawn } from "node:child_process";

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

/** holyWisp on 127.0.0.1:port, up once /health answers. `extra` are more flags (e.g. WebTransport). */
export async function startHolyWisp(bin, port, extra = []) {
  const args = [
    "--host", "127.0.0.1", "--port", String(port), "--log-level", "warn",
    "--allow-tcp", "on", "--allow-udp", "off",
    "--allow-direct-ip", "on", "--allow-private", "on", "--allow-loopback", "on",
    "--enable-v2", "on", "--password-required", "off",
    "--buffer-remaining", "128", "--max-message-size", "262149", "--stream-queue-max", "67108864",
    "--flood-protection", "off", "--reputation", "off", "--serve-webclient", "off",
    "--tcp-nodelay", "on", "--stop-on-stdin-eof", "on",
    ...extra,
  ];
  const proc = spawn(bin, args, { stdio: ["pipe", "inherit", "inherit"] });
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) throw new Error(`holyWisp exited ${proc.exitCode}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return proc;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error("holyWisp did not come up");
}
