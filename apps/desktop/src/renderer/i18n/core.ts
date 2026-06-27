import type { Catalog, TParams } from "./types.js";

const INTERP = /\{(\w+)\}/g;

export function interpolate(template: string, params?: TParams): string {
  if (!params) return template;
  return template.replace(INTERP, (_m, k: string) => (k in params ? String(params[k]) : `{${k}}`));
}

export function translate(catalog: Catalog, key: string, params?: TParams): string {
  const template = catalog[key];
  return template === undefined ? key : interpolate(template, params);
}
