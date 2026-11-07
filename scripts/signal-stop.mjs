#!/usr/bin/env node
// Stops the relay started by `npm run signal:start`.
import { readFileSync, unlinkSync } from 'node:fs';

const PID_FILE = process.env.SIGNALING_PID_FILE || '.signaling.pid';
let pid;
try { pid = Number(readFileSync(PID_FILE, 'utf8').trim()); }
catch { console.log('No running signaling relay found (no pid file).'); process.exit(0); }

if (!Number.isFinite(pid) || pid <= 0) {
  console.error('Invalid pid file; removing it.');
  try { unlinkSync(PID_FILE); } catch {}
  process.exit(1);
}

try {
  process.kill(pid, 'SIGTERM');
  console.log(`Stopped signaling relay (pid ${pid}).`);
} catch (e) {
  console.log(`Relay pid ${pid} not running; removing stale pid file.`);
}
try { unlinkSync(PID_FILE); } catch {}