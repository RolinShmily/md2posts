import fs from 'node:fs';
import path from 'node:path';

/**
 * Walks up from a directory until it finds a Git repository root.
 *
 * Used to expand the `{repoRoot}` token in configured paths such as
 * `sync.defaultCover: "{repoRoot}/public/og/og.png"`.
 */
export function findGitRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  // Guard against pathological symlinks/depth issues.
  for (let depth = 0; depth < 64; depth++) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}
