import { Fragment, type ReactNode, memo } from 'react';
import { cn } from '@/lib/utils';
import { parseMessage, type Inline } from './format';

/** Renders message text as React elements (never HTML), with mentions shown by current name. */
export const MessageText = memo(function MessageText({
  body,
  nameOf,
  myId,
}: {
  body: string;
  nameOf: (userId: string) => string;
  myId: string;
}) {
  return (
    <div className="space-y-1 break-words text-[15px] leading-relaxed">
      {parseMessage(body).map((block, i) => {
        if (block.t === 'codeblock') {
          return (
            <pre
              key={i}
              className="overflow-x-auto rounded-lg bg-raised px-3 py-2 font-mono text-[13px] leading-normal edge"
            >
              <code>{block.text}</code>
            </pre>
          );
        }
        const content = renderInline(block.children, nameOf, myId);
        return block.t === 'quote' ? (
          <blockquote key={i} className="border-l-2 border-bronze pl-3 text-muted">
            {content}
          </blockquote>
        ) : (
          <p key={i} className="whitespace-pre-wrap">
            {content}
          </p>
        );
      })}
    </div>
  );
});

function renderInline(nodes: Inline[], nameOf: (id: string) => string, myId: string): ReactNode {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text':
        return <Fragment key={i}>{n.text}</Fragment>;
      case 'bold':
        return (
          <strong key={i} className="font-semibold">
            {renderInline(n.children, nameOf, myId)}
          </strong>
        );
      case 'italic':
        return <em key={i}>{renderInline(n.children, nameOf, myId)}</em>;
      case 'strike':
        return <s key={i}>{renderInline(n.children, nameOf, myId)}</s>;
      case 'code':
        return (
          <code key={i} className="rounded bg-active px-1 py-0.5 font-mono text-[13px]">
            {n.text}
          </code>
        );
      case 'link':
        return (
          <a
            key={i}
            href={n.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-action underline underline-offset-2 hover:no-underline"
          >
            {n.href.replace(/^https?:\/\//, '')}
          </a>
        );
      case 'mention': {
        const broadcast = n.target === 'channel' || n.target === 'here';
        const you = n.target === myId || broadcast;
        return (
          <span
            key={i}
            className={cn('rounded px-0.5 font-medium', you ? 'bg-action/20 text-ink' : 'text-action')}
          >
            @{broadcast ? n.target : nameOf(n.target)}
          </span>
        );
      }
    }
  });
}
