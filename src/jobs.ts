import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, readdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configPath, loadConfig, safeError, writePrivateJson, type RuntimeConfig } from './config.js';
import { prepareOutput } from './paths.js';
import { executeImage, ImageError, validateImageInput, type ImageInput, type FileReceipt } from './api.js';

interface Job {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  created_at: string;
  updated_at: string;
  pid?: number;
  input: ImageInput;
  edit: boolean;
  result?: Awaited<ReturnType<typeof executeImage>>;
  error?: { code: string; message: string; outcome_unknown: boolean; request_id?: string; partial_files?: FileReceipt[] };
}

function jobPath(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new Error('Invalid job ID.');
  return path.join(path.dirname(configPath()), 'jobs', `${id}.json`);
}

async function readJob(id: string): Promise<Job> {
  try { return JSON.parse(await readFile(jobPath(id), 'utf8')) as Job; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Job not found in this configuration directory.');
    throw error;
  }
}

function publicJob(job: Job) {
  let interrupted = false;
  if (job.status === 'running' && job.pid) {
    try { process.kill(job.pid, 0); }
    catch (error) { interrupted = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  }
  if (job.status === 'queued' && Date.now() - Date.parse(job.created_at) > 30_000) interrupted = true;
  return {
    job_id: job.id,
    status: interrupted ? 'interrupted' : job.status,
    created_at: job.created_at,
    updated_at: job.updated_at,
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...((job.status === 'queued' || job.status === 'running') ? {
      next_step: interrupted
        ? 'Worker stopped or did not start. Outcome may be unknown: inspect the output paths and provider logs before submitting again. Never automatically retry.'
        : 'Call get_job with this job_id. Do not submit another generation for the same request.'
    } : {})
  };
}

export async function getJob(id: string, waitSeconds = 0) {
  const deadline = Date.now() + Math.max(0, Math.min(20, waitSeconds)) * 1000;
  for (;;) {
    const result = publicJob(await readJob(id));
    if (!['running', 'queued'].includes(result.status) || Date.now() >= deadline) return result;
    await new Promise(resolve => setTimeout(resolve, Math.min(500, deadline - Date.now())));
  }
}

export async function startJob(input: ImageInput, edit: boolean) {
  const config = await loadConfig();
  validateImageInput(input, edit);
  await prepareOutput(input.output_path, config.workspaceRoot);
  const id = randomUUID();
  const now = new Date().toISOString();
  const job: Job = { id, input, edit, status: 'queued', created_at: now, updated_at: now };
  await writePrivateJson(jobPath(id), job);
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  try {
    const child = spawn(process.execPath, [cli, '_worker', id], {
      detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true,
      env: { ...process.env, CODEX_IMAGE_GEN_CONFIG: configPath() }
    });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    // Pass the credential/config snapshot through a private pipe, never argv, job JSON,
    // or an extra environment variable. Each worker avoids another keychain lookup.
    child.stdin!.on('error', () => undefined);
    child.stdin!.end(JSON.stringify(config));
    child.unref();
  } catch {
    job.status = 'failed';
    job.updated_at = new Date().toISOString();
    job.error = { code: 'WORKER_START_FAILED', message: 'Could not start the image worker. No provider request was submitted.', outcome_unknown: false };
    await writePrivateJson(jobPath(id), job);
  }
  return getJob(id, 15);
}

export async function cleanJobs(olderThanDays = 7, dryRun = false) {
  if (!Number.isInteger(olderThanDays) || olderThanDays < 0 || olderThanDays > 3650) throw new Error('days must be an integer between 0 and 3650.');
  const directory = path.join(path.dirname(configPath()), 'jobs');
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  let skipped = 0;
  let eligible = 0;
  let entries: string[];
  try { entries = await readdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { removed, skipped, eligible, dry_run: dryRun, older_than_days: olderThanDays };
    }
    throw error;
  }
  for (const entry of entries) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/.test(entry)) continue;
    try {
      if (!(await lstat(path.join(directory, entry))).isFile()) { skipped++; continue; }
      const job = JSON.parse(await readFile(path.join(directory, entry), 'utf8')) as Job;
      const timestamp = Date.parse(job?.updated_at);
      if (!job || `${job.id}.json` !== entry || !['succeeded', 'failed'].includes(job.status) || !Number.isFinite(timestamp) || timestamp > cutoff) { skipped++; continue; }
      eligible++;
      if (!dryRun) { await unlink(path.join(directory, entry)); removed++; }
    } catch { skipped++; }
  }
  return { removed, skipped, eligible, dry_run: dryRun, older_than_days: olderThanDays };
}

export async function runWorker(id: string): Promise<void> {
  const job = await readJob(id);
  if (job.status !== 'queued') return;
  job.status = 'running';
  job.pid = process.pid;
  job.updated_at = new Date().toISOString();
  await writePrivateJson(jobPath(id), job);
  let secret = '';
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > 1024 * 1024) throw new Error('Invalid worker configuration.');
      chunks.push(Buffer.from(chunk));
    }
    let config: RuntimeConfig;
    try { config = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RuntimeConfig; }
    catch { throw new Error('Missing worker configuration pipe. Run image requests through MCP.'); }
    if (!config || typeof config.apiKey !== 'string' || !config.apiKey || typeof config.baseUrl !== 'string') throw new Error('Invalid worker configuration.');
    secret = config.apiKey;
    job.result = await executeImage(config, job.input, job.edit);
    job.status = 'succeeded';
  } catch (error) {
    job.status = 'failed';
    job.error = {
      code: error instanceof ImageError ? error.code : 'WORKER_ERROR',
      message: safeError(error, secret),
      outcome_unknown: error instanceof ImageError ? error.outcomeUnknown : true,
      request_id: error instanceof ImageError ? error.requestId : undefined,
      partial_files: (error as { partial_files?: FileReceipt[] } | null)?.partial_files
    };
  }
  job.updated_at = new Date().toISOString();
  await writePrivateJson(jobPath(id), job);
}
