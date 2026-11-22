import type { FileDto } from '../../../shared/events';
import type { file } from '../../db/schema';

export const toFileDto = (f: typeof file.$inferSelect): FileDto => ({
  id: f.id,
  name: f.name,
  mime: f.mime,
  size: f.size,
  createdAt: f.createdAt.toISOString(),
});
