import { execFileSync } from 'node:child_process';
import type { ProviderId } from '../pipeline/types.js';

const SERVICE = 'agentp';
const ENV: Record<ProviderId, string> = { openai: 'OPENAI_API_KEY', cursor: 'CURSOR_API_KEY' };

/**
 * API keys live in the OS keychain (macOS Keychain, or the Secret Service via `secret-tool` on Linux).
 * An environment variable takes precedence. Keys are never written to run logs.
 */
export function getApiKey(provider: ProviderId): string | null {
  const env = process.env[ENV[provider]];
  if (env) return env;
  try {
    if (process.platform === 'darwin') {
      return execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', provider, '-w'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    }
    if (process.platform === 'linux') {
      return (
        execFileSync('secret-tool', ['lookup', 'service', SERVICE, 'provider', provider], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() || null
      );
    }
  } catch {
    /* not stored */
  }
  return null;
}

export function requireApiKey(provider: ProviderId): string {
  const key = getApiKey(provider);
  if (!key) throw new Error(`no API key for ${provider}: run "agentp keys set ${provider}" or set ${ENV[provider]}`);
  return key;
}

export function setApiKey(provider: ProviderId, key: string): void {
  if (process.platform === 'darwin') {
    execFileSync('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', provider, '-w', key], { stdio: 'ignore' });
  } else if (process.platform === 'linux') {
    execFileSync('secret-tool', ['store', `--label=agentp ${provider}`, 'service', SERVICE, 'provider', provider], {
      input: key,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
  } else {
    throw new Error(`no keychain support on ${process.platform}; set ${ENV[provider]} instead`);
  }
}

export function deleteApiKey(provider: ProviderId): void {
  if (process.platform === 'darwin') {
    execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', provider], { stdio: 'ignore' });
  } else if (process.platform === 'linux') {
    execFileSync('secret-tool', ['clear', 'service', SERVICE, 'provider', provider], { stdio: 'ignore' });
  }
}
