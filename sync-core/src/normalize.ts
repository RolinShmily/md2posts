/**
 * Normalizes an article title to adhere to WeChat's 32-character limit.
 * If title exceeds 32 chars:
 * 1. Tries stripping suffix tags separated by "|" from right to left (common pattern in blog posts)
 * 2. If the primary title is still over 32 chars, truncates to 31 chars + "…"
 */
export function normalizeWeChatTitle(rawTitle: string): { title: string; truncated: boolean } {
  const clean = rawTitle.replace(/\s+/g, ' ').trim();
  const charCount = [...clean].length;

  if (charCount <= 32) {
    return { title: clean, truncated: false };
  }

  // Pattern: "Main Title | Tag 1 | Tag 2" -> strip from right to left
  if (clean.includes('|')) {
    const parts = clean
      .split(/\s*\|\s*/)
      .map((p) => p.trim())
      .filter(Boolean);

    for (let len = parts.length - 1; len >= 1; len--) {
      const candidate = parts.slice(0, len).join(' | ');
      if ([...candidate].length <= 32 && candidate.length >= 4) {
        return { title: candidate, truncated: true };
      }
    }

    // Even parts[0] alone is > 32 chars: truncate parts[0]
    if (parts.length > 0 && [...parts[0]].length > 32) {
      const primaryChars = [...parts[0]];
      return {
        title: `${primaryChars.slice(0, 31).join('')}…`,
        truncated: true,
      };
    }
  }

  // Fallback: Hard truncate at 31 chars + '…'
  const chars = [...clean];
  const truncated = `${chars.slice(0, 31).join('')}…`;
  return { title: truncated, truncated: true };
}

/**
 * Normalizes an article summary/digest to adhere to WeChat's 120-character limit.
 */
export function normalizeWeChatDigest(rawDigest?: string): string | undefined {
  if (!rawDigest) return undefined;
  const clean = rawDigest.replace(/\s+/g, ' ').trim();
  const charCount = [...clean].length;

  if (charCount <= 120) {
    return clean;
  }

  const chars = [...clean];
  return `${chars.slice(0, 118).join('')}…`;
}

export interface SelectablePostItem {
  id: string;
  status: 'new' | 'updated' | 'unchanged' | 'baselined' | 'draft';
}

/**
 * Parses user selection input from interactive CLI prompt.
 * Supports:
 * - 1-based indices: "1", "1,3,5", "1 3 5"
 * - Ranges: "1-4"
 * - Keywords: "new" (all new posts), "updated" (all updated posts)
 * - Direct post slugs: "45-immortalwrt-1"
 */
export function parseArticleSelection(
  rawInput: string,
  orderedItems: SelectablePostItem[]
): string[] {
  const trimmed = rawInput.trim();
  if (!trimmed || /^(q|quit|exit)$/i.test(trimmed)) {
    return [];
  }

  const selectedIds: string[] = [];
  const addId = (id: string) => {
    if (id && !selectedIds.includes(id)) {
      selectedIds.push(id);
    }
  };

  const tokens = trimmed.split(/[\s,，]+/).filter(Boolean);
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === 'new') {
      for (const item of orderedItems) {
        if (item.status === 'new') addId(item.id);
      }
      continue;
    }
    if (lower === 'updated') {
      for (const item of orderedItems) {
        if (item.status === 'updated') addId(item.id);
      }
      continue;
    }

    // Range: e.g. "1-3"
    const rangeMatch = token.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      const lo = Math.max(1, Math.min(start, end));
      const hi = Math.min(orderedItems.length, Math.max(start, end));
      for (let idx = lo; idx <= hi; idx++) {
        addId(orderedItems[idx - 1].id);
      }
      continue;
    }

    // Single 1-based number: e.g. "2"
    if (/^\d+$/.test(token)) {
      const idx = Number(token);
      if (idx >= 1 && idx <= orderedItems.length) {
        addId(orderedItems[idx - 1].id);
      }
      continue;
    }

    // Direct slug match
    const bySlug = orderedItems.find((item) => item.id === token);
    if (bySlug) {
      addId(bySlug.id);
    }
  }

  return selectedIds;
}

