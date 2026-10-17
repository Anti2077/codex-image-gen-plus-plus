import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { APP, DISPLAY_NAME, VERSION, loadConfig, readStoredConfig, safeError } from './config.js';
import { listModels } from './api.js';
import { cleanJobs, getJob, startJob } from './jobs.js';

const imageFields = {
  model: z.string().min(1).max(256).describe('Exact model ID from list_models. Never invent or silently replace it.'),
  prompt: z.string().min(1).max(64000),
  output_path: z.string().min(1).describe('Absolute output filename inside the current user workspace. Prefer output/imagegen/. Extension .png, .jpg, .jpeg or .webp selects output_format. Existing files are never overwritten. For n>1, -1, -2, etc. are appended.'),
  size: z.string().optional().describe('Provider-supported size: auto or WIDTHxHEIGHT. Omit to use the provider default. Actual dimensions are returned.'),
  quality: z.string().optional().describe('Provider-supported quality, e.g. auto, low, medium, high, xhigh, max. Omit unless needed; availability varies by model.'),
  background: z.enum(['auto', 'opaque', 'transparent']).optional(),
  n: z.number().int().min(1).max(4).optional().describe('Number of images; defaults to 1. May increase provider charges.')
};

function result(value: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown>, isError };
}

async function guarded(action: () => Promise<unknown>) {
  try {
    const value = await action();
    const status = (value as { status?: string }).status;
    return result(value, status === 'failed' || status === 'interrupted');
  } catch (error) {
    let secret = '';
    try { secret = (await loadConfig()).apiKey; } catch { /* Config may be missing. */ }
    return result({ error: safeError(error, secret), note: 'No automatic retry was made.' }, true);
  }
}

export async function serve(): Promise<void> {
  try {
    const days = (await readStoredConfig())?.jobRetentionDays ?? 7;
    if (days > 0) await cleanJobs(days);
  } catch { console.error('Job history cleanup skipped; records were retained.'); }
  const server = new McpServer({ name: APP, version: VERSION }, {
    instructions: `${DISPLAY_NAME} uses a user-configured OpenAI-compatible Image API. First list_models, then choose an exact model ID; name hints do not prove capabilities. Choose absolute input/output paths in the current workspace, never assume this server's working directory is the project. Prefer output/imagegen/ for results. Generate/edit may return a pending job after 15 seconds; poll get_job, never resubmit the same request. No automatic provider retries or model fallback. Inspect saved images and show them using their absolute paths. Never ask for or read stored API keys.`
  });
  server.registerTool('list_models', {
    description: 'List models visible to the configured provider API key. Does not generate images or prove generation permission. image_candidate is only a name heuristic.',
    inputSchema: { filter: z.string().max(256).optional().describe('Optional case-insensitive substring filter. Omit to see all IDs.') },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
  }, ({ filter }) => guarded(async () => listModels(await loadConfig(), filter)));
  const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  server.registerTool('generate_image', {
    description: 'Submit one paid image-generation request and save bytes locally. Returns paths/metadata or a job ID to poll with get_job. Never automatically resubmit after timeout/failure. Existing files are protected.',
    inputSchema: imageFields, annotations
  }, input => guarded(() => startJob(input, false)));
  server.registerTool('edit_image', {
    description: 'Edit local images using the provider multipart Images Edits API. Saves to a new absolute path; preserves originals. Optional mask follows provider semantics. Poll returned job ID with get_job.',
    inputSchema: {
      ...imageFields,
      input_paths: z.array(z.string().min(1)).min(1).max(16).describe('Absolute paths to 1–16 local PNG/JPEG/WebP reference images; provider limits may be lower.'),
      mask_path: z.string().min(1).optional().describe('Absolute local mask path. Follow provider requirements for transparency, dimensions and format.')
    }, annotations
  }, input => guarded(() => startJob(input, true)));
  server.registerTool('get_job', {
    description: 'Query an existing image job without submitting or retrying. Jobs survive MCP disconnects while the local worker is alive. On interrupted/unknown outcome, inspect output paths/provider logs before considering another paid request.',
    inputSchema: { job_id: z.string(), wait_seconds: z.number().int().min(0).max(20).optional().describe('Wait up to 20 seconds for completion; defaults to 0.') },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, ({ job_id, wait_seconds }) => guarded(() => getJob(job_id, wait_seconds)));
  await server.connect(new StdioServerTransport());
}
