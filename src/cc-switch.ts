import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import { cleanText, normalizeBaseUrl } from './config.js';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;

export function ccSwitchDirectory(): string {
  return path.resolve(process.env.CODEX_IMAGE_GEN_CCS_DIR || path.join(homedir(), '.cc-switch'));
}

export interface ImportedProvider { baseUrl: string; apiKey: string; providerName: string }

export async function importCCSwitch(directory: string): Promise<ImportedProvider> {
  const root = path.resolve(directory);
  let current: string | undefined;
  try {
    const settings = object(JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8')));
    current = text(settings.currentProviderCodex);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read CC Switch settings.json. Check the directory and JSON format. / 无法读取 CC Switch 本机设置。');
  }
  // Built into Node; loaded only during explicit import. No native npm addon or external sqlite executable.
  const { DatabaseSync } = await import('node:sqlite');
  let db: InstanceType<typeof DatabaseSync>;
  try { db = new DatabaseSync(path.join(root, 'cc-switch.db'), { readOnly: true }); }
  catch { throw new Error('Cannot open CC Switch cc-switch.db read-only. Check the directory. / 无法只读打开 CC Switch 数据库，请检查目录。'); }
  let provider: ObjectValue | undefined;
  try {
    if (current) provider = db.prepare("SELECT name, settings_config FROM providers WHERE app_type = 'codex' AND id = ?").get(current) as ObjectValue | undefined;
    if (!provider) {
      const active = db.prepare("SELECT name, settings_config FROM providers WHERE app_type = 'codex' AND is_current = 1").all();
      if (active.length === 1) provider = active[0] as ObjectValue;
    }
  } catch { throw new Error('Unsupported CC Switch database schema. Use manual setup. / 暂不支持此 CC Switch 数据库结构，请手动配置。'); }
  finally { db.close(); }
  if (!provider) throw new Error('No unambiguous current Codex provider in CC Switch. Select one in CC Switch first. / 未找到明确的当前 Codex 提供商，请先在 CC Switch 中选择。');
  let stored: ObjectValue;
  let config: ObjectValue;
  try {
    stored = object(JSON.parse(String(provider.settings_config)));
    config = typeof stored.config === 'string' ? object(parse(stored.config)) : object(stored.config);
  } catch { throw new Error('Cannot parse the current CC Switch Codex provider settings. / 无法解析当前 Codex 提供商配置。'); }
  const selected = text(config.model_provider);
  const route = selected ? object(object(config.model_providers)[selected]) : {};
  // Never guess another table when model_provider points to a missing or incomplete route.
  let base = text(route.base_url);
  if (!base && (!selected || selected === 'openai')) base = text(config.openai_base_url) || text(config.base_url);
  if (!base && selected === 'openai') base = 'https://api.openai.com/v1';
  if (!base) throw new Error('The active Codex provider has no usable API base URL. / 当前 Codex 提供商没有可用的 API 基础地址。');
  let baseUrl: string;
  try { baseUrl = normalizeBaseUrl(base); }
  catch { throw new Error('CC Switch API URL must be an HTTPS base URL without credentials/query, or loopback HTTP. / CC Switch 地址不是可用的 API 基础地址。'); }
  const envKey = text(route.env_key);
  const auth = object(stored.auth);
  const apiKey = text(route.experimental_bearer_token)
    || (envKey ? text(process.env[envKey]) : text(auth.OPENAI_API_KEY));
  if (!apiKey || /[\r\n]/.test(apiKey) || /PROXY_MANAGED|cc-switch-editor-pending-key/i.test(apiKey)) {
    throw new Error('No usable API key in the active CC Switch provider. ChatGPT OAuth and proxy placeholder tokens cannot be imported; use an API-key provider or manual setup. / 当前配置没有可用 API Key；不导入 ChatGPT 登录令牌或代理占位密钥，请选择 API Key 提供商或手动配置。');
  }
  return { baseUrl, apiKey, providerName: cleanText(provider.name || 'Codex').slice(0, 200) };
}
