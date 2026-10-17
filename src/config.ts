import { mkdir, readFile, rename, rm, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readKey, type CredentialMode } from './credentials.js';

export const APP = 'codex-image-gen-plus-plus';
export const DISPLAY_NAME = 'codex-image-gen++';
export const VERSION = '0.2.0';
export type Language = 'zh-CN' | 'en';
export interface Config {
  version: 1;
  language: Language;
  baseUrl: string;
  apiKey?: string;
  credentialMode?: CredentialMode;
  workspaceRoot?: string;
  jobRetentionDays?: number;
  timeoutSeconds: number;
}
export type RuntimeConfig = Config & { apiKey: string };

export function configPath(): string {
  if (process.env.CODEX_IMAGE_GEN_CONFIG) return path.resolve(process.env.CODEX_IMAGE_GEN_CONFIG);
  const root = process.platform === 'win32'
    ? process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming')
    : process.platform === 'darwin'
      ? path.join(homedir(), 'Library', 'Application Support')
      : process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
  return path.join(root, APP, 'config.json');
}

export function cleanText(value: unknown): string {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
}

export function safeError(error: unknown, secret = ''): string {
  let value = error instanceof Error ? error.message : String(error);
  if (secret) value = value.split(secret).join('[REDACTED]');
  return cleanText(value.replace(/https?:\/\/[^\s"'<>]+/gi, '[URL]').replace(/\b(?:sk-|Bearer\s+)[A-Za-z0-9_.~+\/-]{8,}/gi, '[REDACTED]')).slice(0, 1500);
}

export function validateUrl(value: string): URL {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Use HTTPS, or HTTP on localhost / 127.0.0.1 / [::1].');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('The URL must not include credentials, a query, or a fragment.');
  }
  return url;
}

export function normalizeBaseUrl(value: string): string {
  const url = validateUrl(value.trim());
  if (/\/images\/(generations|edits)\/?$/.test(url.pathname) || /\/models\/?$/.test(url.pathname)) {
    throw new Error('Enter an API base URL such as https://example.com/v1, not an endpoint URL.');
  }
  url.pathname = url.pathname === '/' ? '/v1' : url.pathname.replace(/\/+$/, '');
  return url.href.replace(/\/+$/, '');
}

export async function readStoredConfig(): Promise<Config | undefined> {
  let raw: string;
  try { raw = await readFile(configPath(), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  let value: Config;
  try { value = JSON.parse(raw) as Config; }
  catch { throw new Error(`Invalid configuration JSON. Run ${APP} init again.`); }
  if (!value || value.version !== 1 || !['en', 'zh-CN'].includes(value.language) ||
      typeof value.baseUrl !== 'string' ||
      (value.apiKey !== undefined && typeof value.apiKey !== 'string') ||
      (value.credentialMode !== undefined && !['file', 'keychain'].includes(value.credentialMode)) ||
      (value.workspaceRoot !== undefined && (typeof value.workspaceRoot !== 'string' || !path.isAbsolute(value.workspaceRoot))) ||
      (value.jobRetentionDays !== undefined && (!Number.isInteger(value.jobRetentionDays) || value.jobRetentionDays < 0 || value.jobRetentionDays > 3650))) {
    throw new Error(`Invalid configuration. Run ${APP} init again.`);
  }
  return value;
}

export async function loadConfig(): Promise<RuntimeConfig> {
  const stored = await readStoredConfig();
  const mode = stored?.credentialMode ?? 'file';
  const apiKey = (process.env.CODEX_IMAGE_GEN_API_KEY || (mode === 'keychain' ? await readKey(mode) : stored?.apiKey) || '').trim();
  const baseUrl = process.env.CODEX_IMAGE_GEN_BASE_URL || stored?.baseUrl || '';
  if (!apiKey || !baseUrl) throw new Error(`Configuration missing. Run ${APP} init.`);
  if (/[\r\n]/.test(apiKey)) throw new Error('The API key must be a single line.');
  const timeoutSeconds = stored?.timeoutSeconds ?? 600;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
    throw new Error('timeoutSeconds must be an integer between 1 and 3600.');
  }
  return { version: 1, language: stored?.language ?? 'en', baseUrl: normalizeBaseUrl(baseUrl), apiKey, credentialMode: mode, workspaceRoot: stored?.workspaceRoot, jobRetentionDays: stored?.jobRetentionDays ?? 7, timeoutSeconds };
}

export async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
    if (process.platform !== 'win32') await chmod(file, 0o600);
  } finally { await rm(temporary, { force: true }); }
}

export function personalization(language: Language): string {
  return language === 'zh-CN'
    ? `需要生成或编辑图片时，优先使用 ${APP} MCP。`
    : `When generating or editing images, prefer the ${APP} MCP.`;
}
