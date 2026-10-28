import { cn } from 'cn';
import { Suspense, lazy, useEffect, useRef } from 'react';
import { Outlet, ScrollRestoration, useLocation, useMatches } from 'react-router';
import { useCurrentUser } from '@/features/auth/current-user';
import { ChatBubbles } from '@/features/chat/bubbles/chat-bubbles';
import { useUnreadCount } from '@/features/chat/use-conversations';
import { useUnreadNotifications } from '@/features/notifications/use-notifications';
import { useTimeZoneSync } from '@/features/settings/time-zone';
import { useDocumentBadge } from '@/lib/use-document-badge';
import { Header } from './header';
import { LeftBar } from './left-bar';
import { NavigationProgress } from './navigation-progress';
import { RightBar } from './right-bar';

// Sound and browser notifications are off by default: their code loads only for people who
// turned one on, keeping the first paint small.
const MessageAlerts = lazy(() => import('@/features/chat/message-alerts'));
// Web push stays out of the first paint: nothing about it is needed before the page is up.
const PushSync = lazy(() => import('@/features/push/push-sync'));

const isWide = (handle: unknown): boolean =>
  typeof handle === 'object' && handle !== null && 'wide' in handle && handle.wide === true;

/**
 * Header plus a three-column layout. The left navigation appears from `lg`, the
 * right bar from `xl`; routes with `handle: { wide: true }` (messages) take the
 * whole middle, drop the right bar and, below `md`, get the screen edge to edge: the chat
 * is the page there and a frame around it was wasted space. Sidebars taller than the viewport scroll on their
 * own instead of being cut off. After a navigation that started outside the
 * main area (header, left bar), focus moves to the new page content.
 */
export function AppShell() {
  const me = useCurrentUser();
  const wide = useMatches().some((match) => isWide(match.handle));
  const { pathname } = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const previousPath = useRef(pathname);
  // "(3) Home · BeSo": unread messages and notifications together travel in the tab title.
  useDocumentBadge(useUnreadCount() + useUnreadNotifications());
  useTimeZoneSync(me.settings.timeZone);

  useEffect(() => {
    if (previousPath.current === pathname) return;
    previousPath.current = pathname;
    const main = mainRef.current;
    if (main && !main.contains(document.activeElement)) main.focus({ preventScroll: true });
  }, [pathname]);

  return (
    <div className="min-h-svh">
      <NavigationProgress />
      <ScrollRestoration />
      <Header />
      <div
        className={cn(
          'mx-auto grid max-w-7xl grid-cols-1 gap-6 px-4 py-6 lg:grid-cols-[220px_minmax(0,1fr)]',
          wide
            ? 'max-md:gap-0 max-md:px-0 max-md:py-0'
            : 'xl:grid-cols-[220px_minmax(0,1fr)_320px]',
        )}
      >
        <div className="hidden lg:block">
          <div className="sidebar-column sticky top-20 max-h-[calc(100svh-6.5rem)] overflow-y-auto overscroll-contain">
            <LeftBar />
          </div>
        </div>
        <main
          id="main"
          ref={mainRef}
          tabIndex={-1}
          className={cn('mx-auto w-full min-w-0 outline-none', !wide && 'max-w-2xl')}
        >
          <Outlet />
        </main>
        {wide ? null : (
          <div className="hidden xl:block">
            <div className="sidebar-column sticky top-20 max-h-[calc(100svh-6.5rem)] overflow-y-auto overscroll-contain">
              <RightBar />
            </div>
          </div>
        )}
      </div>
      {me.settings.chatBubbles ? <ChatBubbles /> : null}
      <Suspense fallback={null}>
        <PushSync />
      </Suspense>

      {me.settings.messageSound || me.settings.browserNotifications ? (
        <Suspense fallback={null}>
          <MessageAlerts />
        </Suspense>
      ) : null}
    </div>
  );
}
