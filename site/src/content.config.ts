import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

/** The documentation: one MDX file per page, grouped into four sections. */
const docs = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/docs' }),
  schema: z.object({
    title: z.string().max(60),
    description: z.string().max(200),
    section: z.enum(['start', 'use', 'run', 'inside']),
    order: z.number(),
  }),
});

export const collections = { docs };
