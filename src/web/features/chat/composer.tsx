import { useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { EditorContent, Extension, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import Mention from '@tiptap/extension-mention';
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';
import {
  Bold,
  Code,
  FileText,
  Italic,
  Paperclip,
  SendHorizontal,
  SquareCode,
  Strikethrough,
  TextQuote,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { FileDto } from '../../../shared/events';
import { toMessageText, type EditorNode } from './format';
import { MAX_FILES, useUploads } from './uploads';

// Unsent text per conversation (or thread), kept while you move around the app.
const drafts = new Map<string, unknown>();

export type Mentionable = { id: string; label: string; hint?: string };
type Suggest = { items: Mentionable[]; index: number; command: (item: Mentionable) => void };

type MentionState = { readonly mentionables: Mentionable[]; readonly suggest: Suggest | null };

/**
 * @-mentions: the list is drawn by the composer (above the box, so it also works on phones); this
 * only feeds it matches and handles the arrow, Enter, Tab and Escape keys while it's open.
 */
function mentionExtension(
  live: MentionState,
  show: (p: SuggestionProps<Mentionable>) => void,
  setSuggest: (s: Suggest | null) => void,
) {
  return Mention.configure({
    HTMLAttributes: { class: 'mention' },
    renderText: ({ node }) => `@${String(node.attrs.label ?? '')}`,
    suggestion: {
      char: '@',
      items: ({ query }) => {
        const q = query.toLowerCase();
        return live.mentionables
          .filter((m) =>
            m.label
              .toLowerCase()
              .split(/s+/)
              .some((w) => w.startsWith(q)),
          )
          .slice(0, 8);
      },
      render: () => ({
        onStart: (p: SuggestionProps<Mentionable>) => show(p),
        onUpdate: (p: SuggestionProps<Mentionable>) => show(p),
        onExit: () => setSuggest(null),
        onKeyDown: ({ event }: SuggestionKeyDownProps) => {
          const s = live.suggest;
          if (!s?.items.length) return false;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            const step = event.key === 'ArrowDown' ? 1 : -1;
            setSuggest({ ...s, index: (s.index + step + s.items.length) % s.items.length });
            return true;
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            const item = s.items[s.index];
            if (item) s.command(item);
            return true;
          }
          if (event.key === 'Escape') {
            setSuggest(null);
            return true;
          }
          return false;
        },
      }),
    },
  });
}

/**
 * The message box. Enter sends, Shift+Enter starts a new line (inside a code block Enter stays a
 * new line), Up in an empty box edits your last message, @ suggests people. Files can be attached
 * with the clip, dropped on the box or pasted. Only formatting Huddle can store is enabled.
 */
export function Composer({
  conversationId,
  draftKey = conversationId,
  placeholder,
  mentionables,
  onSend,
  onTyping,
  onEditLast,
  footer,
  autoFocus = true,
}: {
  conversationId: string;
  draftKey?: string;
  placeholder: string;
  mentionables: Mentionable[];
  onSend: (message: { body: string; files: FileDto[] }) => void;
  onTyping: () => void;
  onEditLast?: () => boolean;
  footer?: ReactNode;
  autoFocus?: boolean;
}) {
  const uploads = useUploads(conversationId);
  const [suggest, setSuggest] = useState<Suggest | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // The editor is built once, so it reads changing values through a ref kept current after render.
  const live = useRef({ onSend, onTyping, onEditLast, mentionables, uploads, suggest });
  useLayoutEffect(() => {
    live.current = { onSend, onTyping, onEditLast, mentionables, uploads, suggest };
  });

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          heading: false,
          horizontalRule: false,
          bulletList: false,
          orderedList: false,
          listItem: false,
          listKeymap: false,
          underline: false,
          link: false,
        }),
        Placeholder.configure({ placeholder }),
        mentionExtension(
          {
            // Read when a suggestion opens or a key is pressed, never during render.
            get mentionables() {
              return live.current.mentionables;
            },
            get suggest() {
              return live.current.suggest;
            },
          },
          show,
          setSuggest,
        ),
        Extension.create({
          name: 'huddleKeys',
          addKeyboardShortcuts() {
            return {
              Enter: ({ editor: e }) => {
                if (e.isActive('codeBlock') || live.current.suggest?.items.length) return false;
                submit(e);
                return true;
              },
              ArrowUp: ({ editor: e }) =>
                e.isEmpty && !live.current.uploads.uploads.length && (live.current.onEditLast?.() ?? false),
            };
          },
        }),
      ],
      content: (drafts.get(draftKey) as object | undefined) ?? '',
      // Focus the box on desktop; on phones that would pop the keyboard over the conversation.
      autofocus: autoFocus && window.matchMedia('(pointer: fine)').matches ? 'end' : false,
      editorProps: {
        attributes: {
          'aria-label': placeholder,
          'aria-multiline': 'true',
          role: 'textbox',
          class:
            'max-h-60 min-h-[44px] relative overflow-y-auto px-4 py-3 text-[15px] leading-relaxed outline-none',
        },
        handlePaste: (_view, event) => {
          const files = [...(event.clipboardData?.files ?? [])];
          if (!files.length) return false;
          attach(files);
          return true;
        },
      },
      onUpdate: ({ editor: e }) => {
        drafts.set(draftKey, e.getJSON());
        if (!e.isEmpty) live.current.onTyping();
      },
    },
    [draftKey],
  );

  function show(p: SuggestionProps<Mentionable>) {
    setSuggest((prev) => ({
      items: p.items,
      index: Math.min(prev?.index ?? 0, Math.max(0, p.items.length - 1)),
      command: p.command,
    }));
  }

  function attach(files: File[]) {
    const skipped = live.current.uploads.add(files);
    setNotice(skipped > 0 ? `Up to ${MAX_FILES} files per message.` : null);
  }

  function submit(e: Editor) {
    const { uploads: u } = live.current;
    if (u.busy) {
      setNotice('Still uploading. Send again when the files are ready.');
      return;
    }
    const body = toMessageText(e.getJSON() as EditorNode);
    if (!body && !u.ready.length) return;
    live.current.onSend({ body, files: u.ready });
    e.commands.clearContent(true);
    drafts.delete(draftKey);
    u.clear();
    setNotice(null);
  }

  const onDrop = (event: DragEvent) => {
    setDragging(false);
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    attach([...event.dataTransfer.files]);
  };

  return (
    <div className="px-5 pb-4">
      <div
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'relative rounded-card bg-raised edge focus-within:ring-1 focus-within:ring-edge',
          dragging && 'ring-2 ring-action',
        )}
      >
        {suggest && suggest.items.length > 0 && (
          <ul
            role="listbox"
            aria-label="People to mention"
            className="absolute bottom-full left-0 z-20 mb-2 w-72 max-w-full overflow-hidden rounded-lg bg-raised py-1 shadow-xl edge"
          >
            {suggest.items.map((item, i) => (
              <li
                key={item.id}
                role="option"
                aria-selected={i === suggest.index}
                onMouseDown={(e) => {
                  e.preventDefault();
                  suggest.command(item);
                }}
                className={cn(
                  'flex cursor-pointer items-center gap-2 px-3 py-2 text-sm',
                  i === suggest.index && 'bg-active',
                )}
              >
                <span className="truncate font-medium">{item.label}</span>
                {item.hint && <span className="ml-auto shrink-0 text-xs text-meta">{item.hint}</span>}
              </li>
            ))}
          </ul>
        )}

        {uploads.uploads.length > 0 && (
          <ul aria-label="Attachments" className="flex flex-wrap gap-2 px-3 pt-3">
            {uploads.uploads.map((u) => (
              <li
                key={u.localId}
                className="relative flex h-14 max-w-60 items-center gap-2 overflow-hidden rounded-lg bg-ground pr-8 pl-2 edge"
              >
                {u.previewUrl ? (
                  <img src={u.previewUrl} alt="" className="size-10 rounded object-cover" />
                ) : (
                  <FileText aria-hidden className="size-6 shrink-0 text-meta" />
                )}
                <span className="min-w-0">
                  <span className="block truncate text-sm">{u.name}</span>
                  <span
                    className={cn('block text-xs', u.status === 'failed' ? 'text-attention' : 'text-meta')}
                  >
                    {u.status === 'failed'
                      ? u.error
                      : u.status === 'uploading'
                        ? `Uploading ${Math.round(u.progress * 100)}%`
                        : 'Ready'}
                  </span>
                </span>
                {u.status === 'uploading' && (
                  <span
                    aria-hidden
                    className="absolute bottom-0 left-0 h-0.5 bg-action transition-[width] duration-150"
                    style={{ width: `${u.progress * 100}%` }}
                  />
                )}
                <button
                  type="button"
                  aria-label={`Remove ${u.name}`}
                  onClick={() => uploads.remove(u.localId)}
                  className="absolute top-1 right-1 grid size-6 place-items-center rounded-md text-meta hover:bg-active hover:text-ink"
                >
                  <X aria-hidden className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}

        <EditorContent editor={editor} className="huddle-editor" />
        {footer && <div className="px-4 pb-1">{footer}</div>}
        <div className="flex items-center gap-0.5 px-2 pb-2">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) attach([...e.target.files]);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            aria-label="Attach files"
            title="Attach files"
            onClick={() => fileInput.current?.click()}
            className="grid size-8 place-items-center rounded-md text-meta transition-colors duration-100 hover:bg-active hover:text-ink"
          >
            <Paperclip aria-hidden className="size-4" />
          </button>
          {editor && <FormatBar editor={editor} />}
          <Button
            size="icon"
            className="ml-auto size-8"
            aria-label="Send message"
            title="Send (Enter)"
            disabled={uploads.busy}
            onClick={() => editor && submit(editor)}
          >
            <SendHorizontal aria-hidden className="size-4" />
          </Button>
        </div>
      </div>
      {notice && (
        <p role="status" className="mt-1 text-xs text-attention">
          {notice}
        </p>
      )}
    </div>
  );
}

function FormatBar({ editor }: { editor: Editor }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      codeBlock: e.isActive('codeBlock'),
      quote: e.isActive('blockquote'),
    }),
  });
  const items = [
    { key: 'bold', label: 'Bold (Ctrl+B)', Icon: Bold, run: () => editor.chain().focus().toggleBold().run() },
    {
      key: 'italic',
      label: 'Italic (Ctrl+I)',
      Icon: Italic,
      run: () => editor.chain().focus().toggleItalic().run(),
    },
    {
      key: 'strike',
      label: 'Strikethrough',
      Icon: Strikethrough,
      run: () => editor.chain().focus().toggleStrike().run(),
    },
    { key: 'code', label: 'Code', Icon: Code, run: () => editor.chain().focus().toggleCode().run() },
    {
      key: 'codeBlock',
      label: 'Code block',
      Icon: SquareCode,
      run: () => editor.chain().focus().toggleCodeBlock().run(),
    },
    {
      key: 'quote',
      label: 'Quote',
      Icon: TextQuote,
      run: () => editor.chain().focus().toggleBlockquote().run(),
    },
  ] as const;
  return (
    <div role="toolbar" aria-label="Formatting" className="hidden items-center gap-0.5 sm:flex">
      {items.map(({ key, label, Icon, run }) => (
        <button
          key={key}
          type="button"
          aria-label={label}
          title={label}
          aria-pressed={state[key]}
          onMouseDown={(e) => e.preventDefault()}
          onClick={run}
          className={cn(
            'grid size-8 place-items-center rounded-md text-meta transition-colors duration-100 hover:bg-active hover:text-ink',
            state[key] && 'bg-active text-ink',
          )}
        >
          <Icon aria-hidden className="size-4" />
        </button>
      ))}
    </div>
  );
}
