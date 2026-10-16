import { mkdir, readFile, rename, rm, writeFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const APP = 'codex-image-gen-plus-plus';
export const DISPLAY_NAME = 'codex-image-gen++';
export const VERSION = '0.1.0';
export type Language = 'zh-CN' | 'en';
export interface Config {
  version: 1;
  language: Language;
  baseUrl: string;
  apiKey: string;
  timeoutSeconds: number;
}

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
  const value = JSON.parse(raw) as Config;
  if (value.version !== 1 || !['en', 'zh-CN'].includes(value.language) ||
      typeof value.baseUrl !== 'string' || typeof value.apiKey !== 'string') {
    throw new Error(`Invalid configuration. Run ${APP} init again.`);
  }
  return value;
}

export async function loadConfig(): Promise<Config> {
  const stored = await readStoredConfig();
  const apiKey = (process.env.CODEX_IMAGE_GEN_API_KEY || stored?.apiKey || '').trim();
  const baseUrl = process.env.CODEX_IMAGE_GEN_BASE_URL || stored?.baseUrl || '';
  if (!apiKey || !baseUrl) throw new Error(`Configuration missing. Run ${APP} init.`);
  if (/[\r\n]/.test(apiKey)) throw new Error('The API key must be a single line.');
  const timeoutSeconds = stored?.timeoutSeconds ?? 600;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
    throw new Error('timeoutSeconds must be an integer between 1 and 3600.');
  }
  return { version: 1, language: stored?.language ?? 'en', baseUrl: normalizeBaseUrl(baseUrl), apiKey, timeoutSeconds };
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
    ? `需要生成或编辑图片时，优先使用 ${APP} MCP。先调用 list_models 查看当前提供商可见的模型，根据用户需求选择模型，不要编造模型 ID。模型列表不保证实际生图权限。由你决定提示词、参数及工作区内的绝对输出路径；未指定位置时使用当前工作区的 output/imagegen/。调用 generate_image 或 edit_image；如果返回任务编号，使用 get_job 查询结果，不要重复提交。不要覆盖原图；完成后查看生成文件并向用户展示。不要读取或输出 API Key。`
    : `Prefer the ${APP} MCP for image generation and editing. Call list_models to discover the current provider's visible models and choose one for the user's needs; do not invent model IDs. A model listing does not prove generation access. Choose the prompt, parameters, and an absolute output path inside the current workspace; default to output/imagegen/ within that workspace. Use generate_image or edit_image. If a job ID is returned, use get_job to retrieve it instead of submitting again. Preserve original images. Inspect and show the saved result. Never read or reveal the API key.`;
}
