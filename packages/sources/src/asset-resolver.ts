import fs from 'node:fs';
import path from 'node:path';
import { findGitRoot } from './git.js';

/**
 * Resolves a local asset reference (from frontmatter or Markdown) to an absolute file path.
 *
 * Single source of truth shared by the WeChat and HeyBox pipelines, so both platforms
 * agree on how `image:`, relative image links and `{repoRoot}` / `{postDir}` tokens resolve.
 *
 * Returns `null` for remote URLs, inline data URLs and references that cannot be found.
 */
export function resolveLocalAsset(
  rawRef: string | undefined,
  postDir: string | undefined,
  assetRoots: string[] = ['{postDir}']
): string | null {
  if (!rawRef) return null;
  if (/^https?:\/\//i.test(rawRef) || rawRef.startsWith('data:')) return null;

  let decoded = rawRef.trim();
  if (!decoded) return null;
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Keep the raw value when percent-encoding is malformed.
  }

  if (path.isAbsolute(decoded) && fs.existsSync(decoded) && fs.statSync(decoded).isFile()) {
    return decoded;
  }

  const cleanRel = decoded.replace(/^\.\/+/, '').replace(/^\/+/, '');
  const roots = assetRoots.length > 0 ? assetRoots : ['{postDir}'];
  const repoRoot = findGitRoot(postDir || process.cwd());

  for (const rootPattern of roots) {
    const rootDir = String(rootPattern)
      .replace(/\{postDir\}/g, postDir || '.')
      .replace(/\{repoRoot\}/g, repoRoot || '');
    if (!rootDir) continue;
    const candidate = path.resolve(rootDir, cleanRel);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return null;
}
