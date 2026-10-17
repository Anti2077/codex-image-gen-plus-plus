import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

function inside(file: string, root: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export async function validateWorkspaceRoot(root: string): Promise<string> {
  if (!path.isAbsolute(root)) throw new Error('Workspace root must be absolute.');
  const resolved = await realpath(root);
  if (!(await stat(resolved)).isDirectory()) throw new Error('Workspace root must be an existing directory.');
  return resolved;
}

/** Resolve existing ancestors before creating directories; reject symlink/junction escapes. */
export async function prepareOutput(file: string, root?: string, create = false): Promise<string> {
  const output = path.resolve(file);
  if (!root) {
    if (create) await mkdir(path.dirname(output), { recursive: true });
    return output;
  }
  const absoluteRoot = path.resolve(root);
  if (!inside(output, absoluteRoot) || output === absoluteRoot) throw new Error('Output must be a file inside the configured workspace root.');
  const physicalRoot = await validateWorkspaceRoot(absoluteRoot);
  const relative = path.relative(absoluteRoot, path.dirname(output));
  let directory = physicalRoot;
  const segments = relative.split(path.sep).filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    const next = path.join(directory, segment);
    try { await lstat(next); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!create) return path.join(directory, ...segments.slice(index), path.basename(output));
      try { await mkdir(next); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    directory = await realpath(next);
    if (!inside(directory, physicalRoot)) throw new Error('Output directory symlink/junction escapes the workspace root.');
    if (!(await stat(directory)).isDirectory()) throw new Error('Output parent must be a directory.');
  }
  // Exclusive open in the caller rejects existing files, including final-path symlinks.
  return path.join(directory, path.basename(output));
}
