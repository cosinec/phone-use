import type { Args } from "./types";
export interface Point {
  x: number;
  y: number;
}
export interface Pointer {
  point: Point | null;
  x: number;
  y: number;
  time: number;
}
export function toPhonePoint(
  x: number,
  y: number,
  rect: { left: number; top: number; width: number; height: number },
  width: number,
  height: number,
): Point | null;
export function pointerCommand(
  start: Pointer,
  end: Pointer,
): { tool: string; args: Args } | null;
