import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Message } from '@shared/types';
import { childIndex } from '../lib/tree';
import { MessageItem } from './MessageItem';

// One shared empty list, so messages without branches keep a stable prop and skip re-rendering.
const NO_SIBLINGS: string[] = [];

/**
 * The visible thread, virtualized so a conversation with thousands of
 * messages only mounts what is on screen. While the view is pinned to the
 * bottom it follows a streaming reply; scrolling up releases the pin.
 */
export function MessageList({ conversationId, path, all }: { conversationId: string; path: Message[]; all: Message[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const siblings = useMemo(() => {
    const index = childIndex(all);
    const map = new Map<string, string[]>();
    for (const m of path) {
      const sibs = index.get(m.parentId);
      if (sibs && sibs.length > 1) map.set(m.id, sibs.map((s) => s.id));
    }
    return map;
  }, [path, all]);

  const virtualizer = useVirtualizer({
    count: path.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 140,
    overscan: 6,
    getItemKey: (i) => path[i].id,
  });

  const toBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // A different conversation starts pinned to its newest message.
  useLayoutEffect(() => {
    pinned.current = true;
    setShowJump(false);
    if (path.length) virtualizer.scrollToIndex(path.length - 1, { align: 'end' });
    requestAnimationFrame(toBottom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // Sending a message re-pins.
  useEffect(() => {
    pinned.current = true;
    requestAnimationFrame(toBottom);
  }, [path.length, toBottom]);

  // Follow content growth (streaming text, measured rows) while pinned.
  useEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const ro = new ResizeObserver(() => {
      if (pinned.current) toBottom();
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [toBottom]);

  // Only the user can release the pin (wheel up, keys, dragging the scrollbar).
  // Layout changes also fire scroll events and must not unpin the view.
  const dragging = useRef(false);
  const release = () => {
    pinned.current = false;
  };
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (atBottom) pinned.current = true;
    else if (dragging.current) pinned.current = false;
    setShowJump(!atBottom && !pinned.current);
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onWheel={(e) => e.deltaY < 0 && release()}
        onTouchMove={release}
        onKeyDown={(e) => ['PageUp', 'ArrowUp', 'Home'].includes(e.key) && release()}
        onPointerDown={(e) => {
          if (e.target === scrollRef.current) dragging.current = true; // the scrollbar itself
        }}
        onPointerUp={() => (dragging.current = false)}
        onPointerLeave={() => (dragging.current = false)}
        className="h-full overflow-y-auto"
        data-testid="message-scroll"
      >
        <div ref={innerRef} className="relative mx-auto w-full max-w-[820px] px-6" style={{ height: virtualizer.getTotalSize() + 24 }}>
          {virtualizer.getVirtualItems().map((v) => {
            const m = path[v.index];
            return (
              <div
                key={v.key}
                data-index={v.index}
                ref={virtualizer.measureElement}
                className="absolute top-0 right-6 left-6"
                style={{ transform: `translateY(${v.start + 12}px)` }}
              >
                <MessageItem message={m} siblings={siblings.get(m.id) ?? NO_SIBLINGS} />
              </div>
            );
          })}
        </div>
      </div>
      {showJump && (
        <button
          type="button"
          aria-label="Jump to latest"
          onClick={() => {
            pinned.current = true;
            toBottom();
          }}
          className="absolute bottom-3 left-1/2 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-raised text-muted shadow hover:text-fg"
        >
          <ArrowDown size={15} />
        </button>
      )}
    </div>
  );
}
