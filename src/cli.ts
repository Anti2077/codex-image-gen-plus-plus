#!/usr/bin/env node
import { input, password, select, confirm } from '@inquirer/prompts';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP, DISPLAY_NAME, VERSION, configPath, loadConfig, normalizeBaseUrl, personalization, readStoredConfig, safeError, writePrivateJson, type Config, type Language } from './config.js';
import { listModels } from './api.js';
import { getJob, runWorker } from './jobs.js';
import { serve } from './server.js';
import { ccSwitchDirectory, importCCSwitch, type ImportedProvider } from './cc-switch.js';

async function codexCommand(): Promise<{ command: string; prefix: string[] }> {
  if (process.platform !== 'win32') return { command: 'codex', prefix: [] };
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    const directory = entry.replace(/^"|"$/g, '');
    const executable = path.join(directory, 'codex.exe');
    try { await access(executable); return { command: executable, prefix: [] }; } catch { /* Keep searching. */ }
    // npm's standard Windows shim cannot be spawned without a shell. Invoke its JS entry directly.
    const script = path.join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    try { await access(script); return { command: process.execPath, prefix: [script] }; } catch { /* Keep searching. */ }
  }
  throw new Error('Codex CLI was not found. Install @openai/codex, then run init again, or use the manual MCP configuration below.');
}

function registrationArgs(): string[] {
  const cli = fileURLToPath(import.meta.url);
  return ['mcp', 'add', APP, '--env', `CODEX_IMAGE_GEN_CONFIG=${configPath()}`, '--', process.execPath, cli, 'serve'];
}

async function register(): Promise<void> {
  const { command, prefix } = await codexCommand();
  const child = spawn(command, [...prefix, ...registrationArgs()], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  child.stdout.on('data', chunk => { output = (output + String(chunk)).slice(-8000); });
  child.stderr.on('data', chunk => { output = (output + String(chunk)).slice(-8000); });
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  if (code !== 0) throw new Error(`codex mcp add failed (${code}): ${output}`);
}

function manualConfig(): string {
  // JSON string syntax is a subset of TOML basic strings for these path values.
  const quote = (value: string) => JSON.stringify(value);
  return `[mcp_servers.${APP}]\ncommand = ${quote(process.execPath)}\nargs = [${quote(fileURLToPath(import.meta.url))}, "serve"]\n\n[mcp_servers.${APP}.env]\nCODEX_IMAGE_GEN_CONFIG = ${quote(configPath())}`;
}

async function init(): Promise<void> {
  const language = await select<Language>({ message: `${DISPLAY_NAME} — 选择语言 / Choose language`, choices: [
    { name: '中文', value: 'zh-CN' }, { name: 'English', value: 'en' }
  ] });
  const zh = language === 'zh-CN';
  const t = (cn: string, en: string) => zh ? cn : en;
  let previous: Config | undefined;
  try { previous = await readStoredConfig(); }
  catch { console.error(t('原配置无法读取，将重新配置。', 'Previous configuration could not be read; configuring again.')); }
  const source = await select({ message: t('如何配置图片提供商？', 'How would you like to configure the image provider?'), choices: [
    { name: t('导入 CC Switch 当前 Codex 提供商', 'Import the current Codex provider from CC Switch'), value: 'cc-switch' },
    { name: t('手动输入 API 地址和密钥', 'Enter the API URL and key manually'), value: 'manual' }
  ] });
  let imported: ImportedProvider | undefined;
  if (source === 'cc-switch') {
    const directory = await input({ message: t('CC Switch 数据目录', 'CC Switch data directory'), default: ccSwitchDirectory() });
    try {
      imported = await importCCSwitch(directory);
      console.log(t(`已读取当前 Codex 提供商：${imported.providerName}\nAPI 地址：${imported.baseUrl}\nAPI Key 已导入（隐藏）。`, `Imported current Codex provider: ${imported.providerName}\nAPI URL: ${imported.baseUrl}\nAPI key imported (hidden).`));
      console.log(t('这是一次性导入；之后切换 CC Switch 提供商不会自动同步，可重新运行 init。', 'This is a one-time import. Future CC Switch changes are not synced; rerun init to import again.'));
    } catch (error) {
      console.error(safeError(error));
      console.log(t('继续手动配置。', 'Continuing with manual setup.'));
    }
  }
  const baseUrl = imported?.baseUrl ?? normalizeBaseUrl(await input({
    message: t('API 基础地址（根地址会补 /v1）', 'API base URL (a root URL gets /v1)'),
    default: previous?.baseUrl,
    validate: value => { try { normalizeBaseUrl(value); return true; } catch (error) { return safeError(error); } }
  }));
  const enteredKey = imported?.apiKey ?? await password({
    message: previous ? t('API Key（隐藏输入；留空保留原密钥）', 'API key (hidden; leave empty to keep the current key)') : t('API Key（隐藏输入）', 'API key (hidden)'),
    mask: '*',
    validate: value => (!!value.trim() || !!previous?.apiKey) && !/[\r\n]/.test(value) || t('请输入单行 API Key。', 'Enter a single-line API key.')
  });
  const config: Config = { version: 1, language, baseUrl, apiKey: enteredKey.trim() || previous!.apiKey, timeoutSeconds: previous?.timeoutSeconds ?? 600 };
  console.log(t('正在获取模型列表（不会发起收费生图）…', 'Fetching models (no paid image generation)…'));
  const models = await listModels(config);
  console.log(t(`连接成功：可见 ${models.total} 个模型。`, `Connected: ${models.total} visible models.`));
  const candidates = models.models.filter(model => model.image_candidate);
  if (candidates.length) console.log(t('名称疑似图片模型：', 'Possible image models by name:') + '\n' + candidates.map(model => `  ${model.id}`).join('\n'));
  console.log(t('列表只表示此密钥可见的模型，实际生图能力需调用确认。', 'Listing a model does not verify image-generation access.'));
  await writePrivateJson(configPath(), config);
  console.log(t(`配置已保存：${configPath()}`, `Configuration saved: ${configPath()}`));
  if (await confirm({ message: t('现在注册到 Codex？（会更新同名 MCP 配置）', 'Register with Codex now? (updates an MCP entry with the same name)'), default: true })) {
    try {
      await register();
      console.log(t('已注册到 Codex。请重启 Codex 或开启新对话使工具生效。', 'Registered with Codex. Restart Codex or start a new chat to load the tools.'));
    } catch (error) {
      console.error(t('自动注册未完成：', 'Automatic registration did not complete:') + safeError(error, config.apiKey));
      console.log(t('可将下列内容合并到 Codex 的 config.toml；之后也可重新运行 init：', 'Merge the following into Codex config.toml, or rerun init later:') + '\n\n' + manualConfig());
    }
  }
  console.log('\n' + t('建议把下段加入 Codex 个性化提示词（请手动复制）：', 'Recommended Codex personalization instructions (copy manually):') + '\n\n' + personalization(language));
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'init': return init();
    case 'serve': return serve();
    case '_worker': if (!args[0]) throw new Error('Missing job ID.'); return runWorker(args[0]);
    case 'models':
    case 'doctor': console.log(JSON.stringify(await listModels(await loadConfig(), args[0]), null, 2)); return;
    case 'job': if (!args[0]) throw new Error('Missing job ID.'); console.log(JSON.stringify(await getJob(args[0], 20), null, 2)); return;
    case 'instructions': {
      const language = args[0] === 'zh-CN' ? 'zh-CN' : args[0] === 'en' ? 'en' : (await readStoredConfig())?.language ?? 'en';
      console.log(personalization(language)); return;
    }
    case '--version': case '-v': console.log(VERSION); return;
    case undefined: case '--help': case '-h':
      console.log(`${DISPLAY_NAME} ${VERSION}\n\nUsage: ${APP} <command>\n\n  init                    中文 / English setup, model check and Codex registration\n  models [filter]         Fetch provider-visible model IDs\n  doctor                  Check connection and authentication via /models\n  instructions [zh-CN|en] Print suggested Codex personalization instructions\n  job <id>                Query a generation job (never resubmits)\n  serve                   Run stdio MCP server\n  --version               Print version\n\nConfigure with init. Models and absolute workspace output paths are chosen by Codex.\nNode.js >=22.13.0; Windows, macOS and Linux.`); return;
    default: throw new Error(`Unknown command: ${command}. Run ${APP} --help.`);
  }
}

main().catch(async error => {
  if (error instanceof Error && error.name === 'ExitPromptError') { process.exitCode = 130; return; }
  let secret = '';
  try { secret = (await loadConfig()).apiKey; } catch { /* Unconfigured. */ }
  console.error(safeError(error, secret));
  process.exitCode = 1;
});
