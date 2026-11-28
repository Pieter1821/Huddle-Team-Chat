import { getCollection, type CollectionEntry } from 'astro:content';

export type Doc = CollectionEntry<'docs'>;

export const SECTIONS = [
  { id: 'start', name: 'Get started' },
  { id: 'use', name: 'Use Huddle' },
  { id: 'run', name: 'Run Huddle' },
  { id: 'inside', name: 'Under the hood' },
] as const;

/** Every page, in reading order: by section, then by its order number. */
export async function allDocs(): Promise<Doc[]> {
  const docs = await getCollection('docs');
  const rank = (d: Doc) => SECTIONS.findIndex((s) => s.id === d.data.section);
  return docs.sort((a, b) => rank(a) - rank(b) || a.data.order - b.data.order);
}

export const docHref = (d: Doc) => `/docs/${d.id}`;

/** Minutes to read, at about 220 words a minute. */
export const minutes = (d: Doc) => Math.max(1, Math.round((d.body ?? '').split(/\s+/).length / 220));
