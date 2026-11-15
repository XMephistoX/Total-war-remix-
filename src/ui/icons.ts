// Tiny inline SVG icons for unit classes (stroke uses currentColor).
import type { Visual } from '../sim/data';

const wrap = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const ICONS: Record<Visual, string> = {
  sword: wrap('<path d="M5 19 L17 7 L19 5 L18 8 L6 20"/><path d="M4 15 L9 20"/><path d="M3 21 L5 19"/>'),
  spear: wrap('<path d="M4 20 L18 6"/><path d="M15 5 L20 4 L19 9 Z" fill="currentColor"/>'),
  archer: wrap('<path d="M7 3 C17 7 17 17 7 21"/><path d="M7 3 L7 21"/><path d="M3 12 L16 12"/><path d="M14 10 L16 12 L14 14"/>'),
  skirmisher: wrap('<path d="M5 20 L16 5"/><path d="M9 21 L20 7"/><path d="M14 5 L17 3 L17 7 Z" fill="currentColor"/><path d="M18 7 L21 5 L21 9 Z" fill="currentColor"/>'),
  cavalry: wrap('<path d="M7 21 L8 14 C6 12 6 9 9 7 L12 3 L13 6 L18 8 L19 11 L16 11 L14 10 L13 14 L14 21"/><circle cx="14" cy="7.5" r="0.6" fill="currentColor"/>'),
  general: wrap('<path d="M12 3 L14.6 9 L21 9.5 L16 13.6 L17.6 20 L12 16.5 L6.4 20 L8 13.6 L3 9.5 L9.4 9 Z" fill="currentColor"/>'),
};
