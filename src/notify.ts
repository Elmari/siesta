import { execFile } from 'node:child_process';
import { log } from './log.js';

export function notify(title: string, body: string, sound?: string): void {
  const escTitle = title.replace(/"/g, '\\"');
  const escBody = body.replace(/"/g, '\\"');
  const soundClause = sound ? ` sound name "${sound.replace(/"/g, '\\"')}"` : '';
  const script = `display notification "${escBody}" with title "${escTitle}"${soundClause}`;
  execFile('osascript', ['-e', script], (err, _stdout, stderr) => {
    const stderrTrim = stderr?.trim();
    if (err || stderrTrim) {
      log.warn(
        { err: err?.message, stderr: stderrTrim || undefined, title },
        'siesta: notify (osascript) failed',
      );
    }
  });
}
