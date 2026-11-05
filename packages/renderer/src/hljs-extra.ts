import hljs from 'highlight.js/lib/core';
import powershell from 'highlight.js/lib/languages/powershell';
import dos from 'highlight.js/lib/languages/dos';
import nginx from 'highlight.js/lib/languages/nginx';

/**
 * Common language aliases used in markdown fences to canonical highlight.js names.
 */
export const LANGUAGE_ALIASES: Record<string, string> = {
  // Shell family
  zsh: 'bash',
  sh: 'bash',
  shell: 'bash',
  pwsh: 'powershell',
  ps1: 'powershell',
  cmd: 'dos',
  bat: 'dos',

  // Config / data family
  cfg: 'ini',
  conf: 'ini',
  config: 'ini',
  properties: 'ini',
  toml: 'ini',
  yml: 'yaml',
  jsonc: 'json',
  'moon.json': 'json',
  plist: 'xml',

  // Programming
  py: 'python',
  js: 'javascript',
  ts: 'typescript',
  md: 'markdown',
};

let registered = false;

/**
 * Registers additional highlight.js languages and aliases on the shared hljs core instance.
 * Must be called after vendor/renderer.js has registered its base languages.
 */
export function ensureExtraLanguagesRegistered(): void {
  if (registered) return;
  registered = true;

  hljs.registerLanguage('powershell', powershell);
  hljs.registerLanguage('dos', dos);
  hljs.registerLanguage('nginx', nginx);

  // Register aliases so original fence labels (e.g. zsh, cfg, pwsh, cmd, moon.json) are preserved in UI headers
  const byTarget = new Map<string, string[]>();
  for (const [alias, target] of Object.entries(LANGUAGE_ALIASES)) {
    const list = byTarget.get(target) || [];
    list.push(alias);
    byTarget.set(target, list);
  }

  for (const [languageName, aliases] of byTarget.entries()) {
    if (hljs.getLanguage(languageName)) {
      hljs.registerAliases(aliases, { languageName });
    }
  }
}

/**
 * Resolves a fence info string (e.g. "zsh", "cfg", "pwsh") to a supported highlight.js language name.
 */
export function normalizeCodeLanguage(lang: string): string {
  const clean = lang.trim().toLowerCase().split(/\s+/)[0] || '';
  if (!clean) return '';
  return LANGUAGE_ALIASES[clean] || clean;
}
