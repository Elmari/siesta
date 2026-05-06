import { execFile } from 'node:child_process';

export function notify(title: string, body: string, sound?: string): void {
  const escTitle = title.replace(/"/g, '\\"');
  const escBody = body.replace(/"/g, '\\"');
  const soundClause = sound ? ` sound name "${sound.replace(/"/g, '\\"')}"` : '';
  const script = `display notification "${escBody}" with title "${escTitle}"${soundClause}`;
  execFile('osascript', ['-e', script], () => {
    /* fire-and-forget — failures don't block the loop */
  });
}
