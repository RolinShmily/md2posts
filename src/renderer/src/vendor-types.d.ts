declare module '../vendor/renderer.js' {
  export function renderMarkdown(src: string, theme: any, opts?: any): string;
  export function stripPreviewMeta(html: string): string;
  export function buildFootnoteSection(styles: any, footnotes?: any[]): string;
  export function setImageResolver(fn: any): void;
  export function setImageAspectProvider(fn: any): void;
  export function setGalleryOverrideProvider(fn: any): void;
  export function copyVideoPlaceholder(name?: string): string;
}

declare module '../vendor/themes.js' {
  export const themes: any[];
  export function buildStyles(theme: any, opts?: any): any;
  export const themeCategories: Record<string, string>;
  export const fontOptions: any[];
  export const COLOR_SLOTS: Record<string, any>;
  export const categoryOrder: string[];
}
