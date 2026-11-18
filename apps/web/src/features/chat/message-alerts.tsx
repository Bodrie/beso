import { useQueryClient } from '@tanstack/react-query';
import type { Conversation, Message } from '@beso/shared';
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { useCurrentUser } from '@/features/auth/current-user';
import { flattenPages } from '@/lib/infinite';
import { pushActiveHere } from '@/lib/push';
import { playMessageSound } from '@/lib/notification-sound';
import { queryKeys } from '@/lib/query-keys';
import { useChat } from './chat-context';
import {
  attachmentPhrase,
  conversationName,
  memberById,
  messagePreview,
} from './conversation-display';
import type { ConversationPages } from './use-conversations';

/** Whether this browser can show notifications and the person said yes to them. */
const notificationsGranted = (): boolean =>
  typeof Notification !== 'undefined' && Notification.permission === 'granted';

/**
 * Sound and browser notifications for messages from others, each behind its account
 * preference (Settings → Chat). The sound plays for every message not on screen in this tab
 * (exactly when a bubble appears or the badge goes up), hidden tab or not; the browser
 * notification only while the tab is hidden, since a visible tab shows the bubble instead.
 * The permission is only ever asked for from that switch; here a missing one simply means no
 * notification. Where this browser receives web push, the service worker shows it instead.
 */
export default function MessageAlerts() {
  const me = useCurrentUser();
  const { subscribeToMessages } = useChat();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const settings = useRef(me.settings);
  useEffect(() => {
    settings.current = me.settings;
  }, [me.settings]);

  useEffect(
    () =>
      subscribeToMessages((message: Message, { onScreen }) => {
        if (message.kind !== 'user' || message.senderId === me.id) return;
        const { messageSound, browserNotifications } = settings.current;
        if (messageSound && !onScreen) playMessageSound();
        if (document.visibilityState !== 'hidden') return;
        if (!browserNotifications || !notificationsGranted()) return;
        // This browser gets the push (ADR 0022): its service worker shows the same notification.
        if (pushActiveHere()) return;
        const conversation =
          queryClient.getQueryData<Conversation>(
            queryKeys.conversations.detail(message.conversationId),
          ) ??
          flattenPages(
            queryClient.getQueryData<ConversationPages>(queryKeys.conversations.list),
          ).find((row) => row.id === message.conversationId);
        const sender = conversation
          ? (memberById(conversation, message.senderId)?.user.name ?? 'Someone')
          : 'New message';
        const title =
          conversation && conversation.kind === 'group'
            ? `${sender} · ${conversationName(conversation, me.id)}`
            : sender;
        const body = conversation
          ? messagePreview(message, conversation, me.id)
          : message.content || `Sent ${attachmentPhrase(message)}`;
        try {
          // One notification per conversation: a newer message replaces the older one.
          const notification = new Notification(title, { body, tag: message.conversationId });
          notification.addEventListener('click', () => {
            window.focus();
            void navigate(`/messages/${message.conversationId}`);
            notification.close();
          });
        } catch {
          // Some browsers only allow notifications from a service worker; nothing to do here.
        }
      }),
    [subscribeToMessages, me.id, queryClient, navigate],
  );

  return null;
}
