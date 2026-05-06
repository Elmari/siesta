import { homedir } from 'node:os';
import { join } from 'node:path';

export function configPath(): string {
  return process.env.SIESTA_CONFIG ?? join(homedir(), '.config', 'siesta', 'config.yaml');
}

function appSupport(): string {
  return join(homedir(), 'Library', 'Application Support', 'siesta');
}

export function statePath(): string {
  return join(appSupport(), 'state.json');
}

export function nagPidPath(): string {
  return join(appSupport(), 'nag.pid');
}

export function nagLogPath(): string {
  return join(appSupport(), 'nag.log');
}
