import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configPath, loadConfig, safeError, writePrivateJson } from './config.js';
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
  validateImageInput(input, edit);
  await loadConfig();
  const id = randomUUID();
  const now = new Date().toISOString();
  const job: Job = { id, input, edit, status: 'queued', created_at: now, updated_at: now };
  await writePrivateJson(jobPath(id), job);
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  try {
    const child = spawn(process.execPath, [cli, '_worker', id], {
      detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, CODEX_IMAGE_GEN_CONFIG: configPath() }
    });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } catch {
    job.status = 'failed';
    job.updated_at = new Date().toISOString();
    job.error = { code: 'WORKER_START_FAILED', message: 'Could not start the image worker. No provider request was submitted.', outcome_unknown: false };
    await writePrivateJson(jobPath(id), job);
  }
  return getJob(id, 15);
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
    const config = await loadConfig();
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
