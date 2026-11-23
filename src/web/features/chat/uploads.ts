import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileDto } from '../../../shared/events';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 10;

export type Upload = {
  localId: string;
  name: string;
  size: number;
  /** 0..1 while uploading. */
  progress: number;
  status: 'uploading' | 'done' | 'failed';
  error?: string;
  file?: FileDto;
  /** A local preview for images, revoked when the upload is removed. */
  previewUrl?: string;
};

/**
 * Files attached to the message being written. Each one uploads as soon as it's picked (with real
 * progress), so sending is instant; the message then just refers to the uploaded file ids.
 */
export function useUploads(conversationId: string) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const requests = useRef(new Map<string, XMLHttpRequest>());

  const patch = (localId: string, change: Partial<Upload>) =>
    setUploads((list) => list.map((u) => (u.localId === localId ? { ...u, ...change } : u)));

  // The current list, readable from event handlers (state updaters must stay free of side effects).
  const listRef = useRef(uploads);
  useEffect(() => {
    listRef.current = uploads;
  }, [uploads]);

  const add = (files: FileList | File[]) => {
    const room = MAX_FILES - listRef.current.length;
    const accepted = [...files].slice(0, Math.max(0, room)).map((raw) => {
      const tooBig = raw.size > MAX_FILE_BYTES;
      const upload: Upload = {
        localId: crypto.randomUUID(),
        name: raw.name || 'file',
        size: raw.size,
        progress: 0,
        status: tooBig || raw.size === 0 ? 'failed' : 'uploading',
        ...(tooBig ? { error: 'Over 25 MB' } : raw.size === 0 ? { error: 'Empty file' } : {}),
        ...(raw.type.startsWith('image/') ? { previewUrl: URL.createObjectURL(raw) } : {}),
      };
      return { upload, raw };
    });
    listRef.current = [...listRef.current, ...accepted.map((a) => a.upload)];
    setUploads(listRef.current);
    for (const { upload, raw } of accepted) if (upload.status === 'uploading') start(upload.localId, raw);
    return files.length - accepted.length; // how many didn't fit
  };

  function start(localId: string, raw: File) {
    const xhr = new XMLHttpRequest();
    requests.current.set(localId, xhr);
    xhr.open('POST', `/api/conversations/${conversationId}/files`);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('x-file-name', encodeURIComponent(raw.name || 'file'));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) patch(localId, { progress: e.loaded / e.total });
    };
    xhr.onload = () => {
      requests.current.delete(localId);
      try {
        const body = JSON.parse(xhr.responseText) as { file?: FileDto; error?: { message?: string } };
        if (xhr.status === 201 && body.file) {
          patch(localId, {
            status: 'done',
            progress: 1,
            file: { ...body.file, createdAt: new Date().toISOString() },
          });
        } else {
          patch(localId, { status: 'failed', error: body.error?.message ?? 'Upload failed' });
        }
      } catch {
        patch(localId, { status: 'failed', error: 'Upload failed' });
      }
    };
    xhr.onerror = () => {
      requests.current.delete(localId);
      patch(localId, { status: 'failed', error: 'Connection lost' });
    };
    xhr.send(raw);
  }

  const remove = useCallback((localId: string) => {
    requests.current.get(localId)?.abort();
    requests.current.delete(localId);
    setUploads((list) => {
      const gone = list.find((u) => u.localId === localId);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      return list.filter((u) => u.localId !== localId);
    });
  }, []);

  /** After sending: forget the attachments (keeping nothing that was uploaded but unsent). */
  const clear = useCallback(() => {
    setUploads((list) => {
      for (const u of list) if (u.previewUrl) URL.revokeObjectURL(u.previewUrl);
      return [];
    });
  }, []);

  useEffect(() => {
    const pending = requests.current;
    return () => {
      for (const xhr of pending.values()) xhr.abort();
    };
  }, []);

  return {
    uploads,
    add,
    remove,
    clear,
    busy: uploads.some((u) => u.status === 'uploading'),
    ready: uploads.filter((u) => u.status === 'done' && u.file).map((u) => u.file!),
  };
}
