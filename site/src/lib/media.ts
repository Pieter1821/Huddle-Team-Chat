import type { ImageMetadata } from 'astro';

/** Real screenshots of the app, by name (made by capture/seed-and-capture.mjs). */
const screens = import.meta.glob<{ default: ImageMetadata }>('../assets/screens/*.png', { eager: true });

export function screen(name: string): ImageMetadata | undefined {
  return screens[`../assets/screens/${name}.png`]?.default;
}

/** Real clips of the app live in public/media as <name>.mp4, .webm and a .jpg poster. */
const clips = import.meta.glob('../../public/media/*.mp4', { query: '?url', eager: true });

export function hasClip(name: string): boolean {
  return `../../public/media/${name}.mp4` in clips;
}
