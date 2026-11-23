import { useLayoutEffect, useRef } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import { Extension } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import { Bold, Code, Italic, SendHorizontal, SquareCode, Strikethrough, TextQuote } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toMessageText, type EditorNode } from './format';

// Unsent text per conversation, kept while you move around the app.
const drafts = new Map<string, unknown>();

/**
 * The message box. Enter sends, Shift+Enter starts a new line (inside a code block Enter stays a
 * new line), Up in an empty box edits your last message. Only formatting Huddle can store is
 * enabled, so pasted rich text is reduced to bold, italic, strike, code and quotes.
 */
export function Composer({
  conversationId,
  placeholder,
  onSend,
  onTyping,
  onEditLast,
}: {
  conversationId: string;
  placeholder: string;
  onSend: (text: string) => void;
  onTyping: () => void;
  onEditLast: () => boolean;
}) {
  // Handlers change every render; the editor is built once, so it reads them through refs.
  const handlers = useRef({ onSend, onTyping, onEditLast });
  useLayoutEffect(() => {
    handlers.current = { onSend, onTyping, onEditLast };
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
        Extension.create({
          name: 'huddleKeys',
          addKeyboardShortcuts() {
            return {
              Enter: ({ editor: e }) => {
                if (e.isActive('codeBlock')) return false;
                submit(e);
                return true;
              },
              ArrowUp: ({ editor: e }) => e.isEmpty && handlers.current.onEditLast(),
            };
          },
        }),
      ],
      content: (drafts.get(conversationId) as object | undefined) ?? '',
      // Focus the box on desktop; on phones that would pop the keyboard over the conversation.
      autofocus: window.matchMedia('(pointer: fine)').matches ? 'end' : false,
      editorProps: {
        attributes: {
          'aria-label': placeholder,
          'aria-multiline': 'true',
          role: 'textbox',
          class: 'max-h-60 min-h-[44px] overflow-y-auto px-4 py-3 text-[15px] leading-relaxed outline-none',
        },
      },
      onUpdate: ({ editor: e }) => {
        drafts.set(conversationId, e.getJSON());
        if (!e.isEmpty) handlers.current.onTyping();
      },
    },
    [conversationId],
  );

  function submit(e: Editor) {
    const text = toMessageText(e.getJSON() as EditorNode);
    if (!text) return;
    handlers.current.onSend(text);
    e.commands.clearContent(true);
    drafts.delete(conversationId);
  }

  return (
    <div className="px-5 pb-4">
      <div className="rounded-card bg-raised edge focus-within:ring-1 focus-within:ring-edge">
        <EditorContent editor={editor} className="huddle-editor" />
        <div className="flex items-center gap-0.5 px-2 pb-2">
          {editor && <FormatBar editor={editor} />}
          <Button
            size="icon"
            className="ml-auto size-8"
            aria-label="Send message"
            title="Send (Enter)"
            onClick={() => editor && submit(editor)}
          >
            <SendHorizontal aria-hidden className="size-4" />
          </Button>
        </div>
      </div>
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
    <div role="toolbar" aria-label="Formatting" className="flex items-center gap-0.5">
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
