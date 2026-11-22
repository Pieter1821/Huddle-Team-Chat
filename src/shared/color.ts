// WCAG 2.2 contrast maths, shared by the API (which enforces it) and the web app (which shows it live).

export const DEFAULT_ACCENT = '#00b18c';
/** The app's charcoal ground; buttons put this colour as text on the accent. */
export const CHARCOAL = '#151515';
/** Text on a filled accent button must reach WCAG AA for normal text. */
export const MIN_ACCENT_CONTRAST = 4.5;

export const isHexColor = (value: string) => /^#[0-9a-fA-F]{6}$/.test(value);

/** Relative luminance as defined by WCAG (sRGB, linearised). */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio between two #RRGGBB colours, from 1 (identical) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
