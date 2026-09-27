import { execFile } from 'node:child_process';

export interface Notifier {
  notify(title: string, body: string): void;
}

/** Desktop notification (v1). Slack and email can implement the same interface later. Best effort only. */
export const desktopNotifier: Notifier = {
  notify(title, body) {
    if (process.env.AGENTP_NOTIFY === 'off') return;
    const quiet = () => {};
    if (process.platform === 'darwin') {
      const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      execFile('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`], quiet);
    } else if (process.platform === 'linux') {
      execFile('notify-send', [title, body], quiet);
    } else {
      process.stderr.write('\x07');
    }
  },
};

export const silentNotifier: Notifier = { notify() {} };
