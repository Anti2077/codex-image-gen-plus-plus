import { imageSize } from 'image-size';
import { open, mkdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { type Config, cleanText, safeError, validateUrl } from './config.js';

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 192 * 1024 * 1024;
export class ImageError extends Error {
  constructor(message: string, readonly code: string, readonly outcomeUnknown = false, readonly requestId?: string) {
    super(message);
    this.name = 'ImageError';
  }
}

export interface ImageInput {
  model: string;
  prompt: string;
  output_path: string;
  size?: string;
  quality?: string;
  background?: 'auto' | 'opaque' | 'transparent';
  n?: number;
  input_paths?: string[];
  mask_path?: string;
}
export interface FileReceipt {
  path: string;
  mime_type: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  requested_size: string | null;
  size_matches_request: boolean | null;
}

async function boundedBytes(response: Response, limit: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new ImageError('Response exceeded the size limit.', 'RESPONSE_TOO_LARGE', true);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new ImageError('Response exceeded the size limit.', 'RESPONSE_TOO_LARGE', true);
      chunks.push(value);
    }
    return Buffer.concat(chunks, length);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function requestId(response: Response): string | undefined {
  const value = response.headers.get('x-request-id') || response.headers.get('request-id') || response.headers.get('x-smartapi-request-id');
  return value ? cleanText(value).slice(0, 256) : undefined;
}

async function requestJson(config: Config, endpoint: string, init: RequestInit = {}): Promise<{ body: Record<string, unknown>; id?: string }> {
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/${endpoint}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${config.apiKey}` },
      redirect: 'error',
      signal: AbortSignal.timeout(endpoint === 'models' ? 30_000 : config.timeoutSeconds * 1000)
    });
    const bytes = await boundedBytes(response, endpoint === 'models' ? 8 * 1024 * 1024 : MAX_RESPONSE_BYTES);
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>; }
    catch { throw new ImageError(`HTTP ${response.status}: provider returned non-JSON data.`, 'INVALID_RESPONSE', init.method === 'POST', requestId(response)); }
    if (!response.ok) {
      const detail = payload?.error as { message?: string; code?: string } | undefined;
      const message = typeof detail?.message === 'string' ? ` ${safeError(detail.message, config.apiKey)}` : '';
      throw new ImageError(`HTTP ${response.status}.${message}`, `HTTP_${response.status}`, response.status >= 500 && init.method === 'POST', requestId(response));
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ImageError('Provider returned invalid JSON.', 'INVALID_RESPONSE', init.method === 'POST');
    return { body: payload, id: requestId(response) };
  } catch (error) {
    if (error instanceof ImageError) throw error;
    const timeout = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);
    throw new ImageError(timeout ? 'Provider request timed out. No automatic retry was made.' : `Provider connection failed: ${safeError(error, config.apiKey)}. No automatic retry was made.`, timeout ? 'UPSTREAM_TIMEOUT' : 'NETWORK_ERROR', init.method === 'POST');
  }
}

export async function listModels(config: Config, filter?: string) {
  const { body, id } = await requestJson(config, 'models');
  if (!Array.isArray(body.data)) throw new ImageError('Expected a model list in data[].', 'INVALID_MODEL_LIST');
  const models = [...new Set(body.data.flatMap((item: unknown) => {
    if (item && typeof item === 'object' && 'id' in item && typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/.test(item.id)) return [item.id];
    return [];
  }))].sort();
  const shown = filter ? models.filter(model => model.toLowerCase().includes(filter.toLowerCase())) : models;
  return {
    models: shown.map(model => ({ id: model, image_candidate: /image|dall-e|imagen|flux|sdxl|stable.diffusion|seedream|nano.banana/i.test(model) })),
    total: models.length,
    request_id: id,
    note: 'Provider-visible IDs, not verified image capabilities. image_candidate is a name heuristic only. Choose a model explicitly; IDs are never rewritten.'
  };
}

export function validateImageInput(input: ImageInput, edit: boolean): void {
  if (!input.model.trim() || input.model.length > 256 || !input.prompt.trim() || input.prompt.length > 64_000) throw new ImageError('A model and prompt are required (model <= 256, prompt <= 64000 characters).', 'INVALID_ARGUMENT');
  if (!path.isAbsolute(input.output_path)) throw new ImageError('output_path must be absolute. Choose a path inside the current workspace.', 'INVALID_PATH');
  formatForPath(input.output_path);
  if (input.size !== undefined && !/^(auto|[1-9]\d{1,4}x[1-9]\d{1,4})$/.test(input.size)) throw new ImageError('size must be auto or WIDTHxHEIGHT.', 'INVALID_SIZE');
  if (input.quality !== undefined && (!/^[a-z][a-z0-9_-]{0,31}$/.test(input.quality))) throw new ImageError('Invalid quality value.', 'INVALID_QUALITY');
  const n = input.n ?? 1;
  if (!Number.isInteger(n) || n < 1 || n > 4) throw new ImageError('n must be between 1 and 4.', 'INVALID_COUNT');
  if (edit && (!input.input_paths?.length || input.input_paths.length > 16)) throw new ImageError('Editing requires 1–16 absolute input_paths.', 'INVALID_INPUT_IMAGES');
  for (const file of [...(input.input_paths ?? []), ...(input.mask_path ? [input.mask_path] : [])]) {
    if (!path.isAbsolute(file)) throw new ImageError('Input and mask paths must be absolute.', 'INVALID_PATH');
  }
}

function formatForPath(file: string): 'png' | 'jpeg' | 'webp' {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'png';
  if (ext === '.jpg' || ext === '.jpeg') return 'jpeg';
  if (ext === '.webp') return 'webp';
  throw new ImageError('Output filename must end in .png, .jpg, .jpeg, or .webp.', 'INVALID_FORMAT');
}

function inspectImage(bytes: Buffer): { mime: string; width: number; height: number; format: string } {
  if (bytes.length > MAX_IMAGE_BYTES || bytes.length < 12) throw new ImageError('Invalid image length (maximum 50 MiB).', 'INVALID_IMAGE');
  try {
    const info = imageSize(bytes);
    const format = info.type === 'jpg' ? 'jpeg' : info.type;
    if (!['png', 'jpeg', 'webp'].includes(format ?? '') || !info.width || !info.height) throw new Error('Unsupported image');
    return { mime: `image/${format}`, width: info.width, height: info.height, format: format! };
  } catch { throw new ImageError('Expected PNG, JPEG, or WebP image bytes.', 'INVALID_IMAGE'); }
}

async function inputBlob(file: string): Promise<Blob> {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new ImageError('Input image must be a file no larger than 50 MiB.', 'INVALID_INPUT_IMAGE');
    const bytes = await handle.readFile();
    const info = inspectImage(bytes);
    return new Blob([new Uint8Array(bytes)], { type: info.mime });
  } finally { await handle.close(); }
}

async function downloadImage(value: string, timeoutSeconds: number): Promise<Buffer> {
  const assetUrl = (value: string): URL => {
    const parsed = new URL(value);
    const query = parsed.search;
    parsed.search = '';
    const result = validateUrl(parsed.href);
    result.search = query;
    return result;
  };
  let url = assetUrl(value);
  const signal = AbortSignal.timeout(timeoutSeconds * 1000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    // Provider credentials are deliberately never sent to image URLs, including redirects.
    const response = await fetch(url, { redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new ImageError('Image download redirect has no location.', 'DOWNLOAD_FAILED', true);
      url = assetUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ImageError(`Image download returned HTTP ${response.status}.`, 'DOWNLOAD_FAILED', true);
    }
    return boundedBytes(response, MAX_IMAGE_BYTES);
  }
  throw new ImageError('Too many image download redirects.', 'DOWNLOAD_FAILED', true);
}

async function decodeOutput(item: unknown, config: Config): Promise<Buffer> {
  if (!item || typeof item !== 'object') throw new ImageError('Missing image data.', 'INVALID_RESPONSE', true);
  const record = item as Record<string, unknown>;
  if (typeof record.b64_json === 'string') {
    const encoded = record.b64_json.replace(/\s/g, '');
    if (!encoded || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new ImageError('Invalid base64 image.', 'INVALID_RESPONSE', true);
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) throw new ImageError('Invalid base64 image.', 'INVALID_RESPONSE', true);
    return bytes;
  }
  const asset = record.url ?? record.image_url;
  if (typeof asset === 'string') {
    // Validate the origin without discarding signed URL query parameters.
    const parsed = new URL(asset);
    const query = parsed.search;
    parsed.search = '';
    const safe = validateUrl(parsed.href);
    safe.search = query;
    return downloadImage(safe.href, config.timeoutSeconds);
  }
  throw new ImageError('Expected data[].b64_json, url, or image_url.', 'INVALID_RESPONSE', true);
}

export async function executeImage(config: Config, input: ImageInput, edit: boolean) {
  validateImageInput(input, edit);
  const format = formatForPath(input.output_path);
  const n = input.n ?? 1;
  const parsed = path.parse(input.output_path);
  const paths = n === 1 ? [input.output_path] : Array.from({ length: n }, (_, i) => path.join(parsed.dir, `${parsed.name}-${i + 1}${parsed.ext}`));
  let form: FormData | undefined;
  if (edit) {
    form = new FormData();
    for (const file of input.input_paths!) form.append(input.input_paths!.length === 1 ? 'image' : 'image[]', await inputBlob(file), path.basename(file));
    if (input.mask_path) form.append('mask', await inputBlob(input.mask_path), path.basename(input.mask_path));
  }
  const payload: Record<string, unknown> = { model: input.model, prompt: input.prompt, n, output_format: format };
  for (const key of ['size', 'quality', 'background'] as const) if (input[key] !== undefined) payload[key] = input[key];
  if (form) for (const [key, value] of Object.entries(payload)) form.append(key, String(value));
  const reservations: { file: string; handle: FileHandle; saved: boolean }[] = [];
  const files: FileReceipt[] = [];
  let submitted = false;
  let providerId: string | undefined;
  try {
    // Reserve every destination before starting a paid request; exclusive opens never replace files.
    for (const file of paths) {
      await mkdir(path.dirname(file), { recursive: true });
      try { reservations.push({ file, handle: await open(file, 'wx', 0o600), saved: false }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ImageError(`Output already exists: ${file}. Choose a new filename.`, 'OUTPUT_EXISTS');
        throw error;
      }
    }
    const started = Date.now();
    submitted = true;
    const { body, id } = await requestJson(config, edit ? 'images/edits' : 'images/generations', {
      method: 'POST',
      ...(form ? { body: form } : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    });
    providerId = id;
    if (!Array.isArray(body.data) || body.data.length !== n) throw new ImageError(`Expected ${n} image(s); provider returned ${Array.isArray(body.data) ? body.data.length : 0}. No retry was made.`, 'INVALID_RESPONSE', true, id);
    for (const [index, item] of body.data.entries()) {
      const bytes = await decodeOutput(item, config);
      const info = inspectImage(bytes);
      if (info.format !== format) throw new ImageError(`Provider returned ${info.format}, but ${format} was requested.`, 'FORMAT_MISMATCH', true, id);
      const reservation = reservations[index]!;
      await reservation.handle.writeFile(bytes);
      await reservation.handle.sync();
      reservation.saved = true;
      files.push({ path: reservation.file, mime_type: info.mime, width: info.width, height: info.height, bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), requested_size: input.size ?? null,
        size_matches_request: !input.size || input.size === 'auto' ? null : `${info.width}x${info.height}` === input.size });
    }
    return { model: input.model, operation: edit ? 'edit' : 'generate', files, request_id: id, elapsed_ms: Date.now() - started,
      note: 'Inspect the saved files and show them to the user. Dimensions are measured from the returned image bytes.' };
  } catch (error) {
    const failure = error instanceof ImageError ? error : new ImageError(safeError(error, config.apiKey), 'IMAGE_FAILED', submitted, providerId);
    if (submitted && !failure.code.startsWith('HTTP_')) Object.assign(failure, { outcomeUnknown: true });
    Object.assign(failure, { partial_files: files });
    if (submitted && !failure.requestId) Object.assign(failure, { requestId: providerId });
    throw failure;
  } finally {
    for (const reservation of reservations) {
      await reservation.handle.close().catch(() => undefined);
      if (!reservation.saved) await unlink(reservation.file).catch(() => undefined);
    }
  }
}
