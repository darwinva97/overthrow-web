// Colores comunes de la interfaz y acceso al catálogo de efectos (vfx/catalog.ts).
// El catálogo completo de poderes, estados, proyectiles y zonas vive en vfx/catalog.ts y lo
// comparten los dos modos de dibujo; aquí se reexporta lo que usan otras partes del cliente.
import { FX, PROJ, STATUS, projStyle, statusStyle, type FxDef, type StatusDef } from './vfx/catalog';

export { FX, STATUS, PROJ, statusStyle };
export type FxStyle = FxDef;
export type StatusStyle = StatusDef;

/** Color principal de un proyectil (núcleo y estela). */
export function projColor(fx: string, a?: string) { return projStyle(fx, a).c; }
/** Tamaño del núcleo de un proyectil en unidades de mundo. */
export function projSize(fx: string, a?: string) { const d = projStyle(fx, a).def; return d.wave ?? d.s; }

export const ORB_COLOR: Record<string, string> = { common: '#7fe0ff', rare: '#6a8cff', epic: '#c27bff' };
export const ATTR_COLOR: Record<string, string> = { str: '#d4483b', agi: '#4fae4a', int: '#3f8fe0', all: '#d9a441' };
