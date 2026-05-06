import { homedir } from 'node:os';
import { join } from 'node:path';

export function configPath(): string {
  return process.env.SIESTA_CONFIG ?? join(homedir(), '.config', 'siesta', 'config.yaml');
}

export function statePath(): string {
  return join(homedir(), 'Library', 'Application Support', 'siesta', 'state.json');
}
