import { createHash } from 'node:crypto';
import path from 'node:path';
import { APP, configPath } from './config.js';

export type CredentialMode = 'file' | 'keychain';
const cache = new Map<string, Promise<string | undefined>>();

function account(): string {
  return `api-key-${createHash('sha256').update(path.resolve(configPath())).digest('hex').slice(0, 16)}`;
}

async function entry() {
  try {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    // Require a persistent Linux store instead of falling back to a volatile kernel keyring.
    return new AsyncEntry(APP, account(), { linux: { store: 'secret-service' } });
  }
  catch { throw new Error('The optional keychain integration is unavailable on this installation. / 当前安装没有可用的系统密钥库集成。'); }
}

export async function saveKey(mode: CredentialMode, value: string): Promise<void> {
  if (mode === 'file') return;
  const name = account();
  try { await (await entry()).setPassword(value); }
  catch { throw new Error('Cannot save to the system keychain. Unlock it or choose file storage. / 无法写入系统密钥库，请解锁或选择文件存储。'); }
  cache.set(name, Promise.resolve(value));
}

export async function readKey(mode: CredentialMode): Promise<string | undefined> {
  if (mode === 'file') return;
  const name = account();
  let pending = cache.get(name);
  if (!pending) {
    pending = (async () => {
      try { return (await (await entry()).getPassword())?.trim() || undefined; }
      catch { throw new Error('Cannot read the system keychain. Unlock it and restart MCP, or rerun init. / 无法读取系统密钥库，请解锁后重启 MCP，或重新初始化。'); }
    })();
    // Cache success and failure: concurrent tool calls must not repeatedly prompt for access.
    cache.set(name, pending);
  }
  return pending;
}

export async function deleteKey(mode: CredentialMode): Promise<void> {
  if (mode === 'file') return;
  const name = account();
  await (await entry()).deletePassword();
  cache.delete(name);
}
