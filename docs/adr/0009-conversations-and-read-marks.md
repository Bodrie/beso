# 0009 – Conversations as records, read state per member

Date: 2026-10-16 · Status: Accepted · Plan: §4.8 (8e)

## Context

Until v2.1 a message had a sender and a recipient, "conversations" were derived on the fly (`DISTINCT ON` the other party) and read state was a `read_at` stamp on every message. That shape cannot express a group: there is no recipient, no title, no member list, and "read" has to be answered per person.

## Decision

- `conversations` is a table with a `kind` (`direct` | `group`), an optional `title`, a creator and a denormalised `last_message_at`. A direct conversation is unique per pair through `direct_key` (`<smaller user id>:<larger user id>`) and is created the first time either side opens the thread (`PUT /conversations/direct/:userId`); it is listed only once it has a message. A group is created on purpose (`POST /conversations`) and is listed right away.
- `conversation_members` holds who is in a conversation and their read mark: `last_read_at`. Everything created up to that moment counts as read. Writing a message moves the author's own mark. Unread counts are computed from it (`messages from others with created_at > last_read_at`), and so are read receipts ("Seen" when the other member's mark passed my last message; "Seen by Bob", "Seen by everyone" in a group). Messages carry no read state of their own.
- Messages belong to a conversation (`conversation_id`), not to a recipient. Every list, send, read and member change goes through a membership check, and non-members get a 404 so the existence of a group never leaks.
- Membership changes stay small: any member can add people, anyone can leave, the last one out deletes the group. No admin roles, no renaming, no removing others. Those are backlog items if they are ever wanted.
- Realtime fan-out uses the existing per-user rooms: domain events carry the member ids, and the gateway emits to each `user:<id>` room (never to an empty room list, which socket.io treats as "everyone"). Membership changes push a `conversation:update` reference and the client refetches the conversation; a member who left gets `conversation:removed`. Typing relays look the membership up per signal; relays are chained per socket so a "stopped" can never overtake a "started".
- The migration `20261016101500_group_conversations` carries existing direct messages over: one conversation per pair, both people as members, each member's mark set to the newest message they had read or written.

## Amendment 2026-10-19: chat bubbles (plan B3a)

Messages that arrive while the viewer is elsewhere in the app surface as **chat bubbles**:
round avatars docked at the right edge (a row under the header on phones), one per
conversation, four at most, newest nearest the corner, each carrying the conversation's unread
count. A bubble opens a **chat window**, a docked mini thread (two side by side on a desktop,
one full-width panel on a phone) that reuses the messages page's `Thread` and composer and
therefore its cache and read marks: opening a window reads the thread, a message into an open
window is read on arrival, and a bubble on its own never reads anything. Minimising keeps the
bubble; the X hides a conversation until its next message; visiting the messages page clears
the layer (the page owns the threads); the viewer's own messages never raise a bubble. State is
per tab and in memory. The preference `chatBubbles` (default on) lives in `users.settings`, a
JSON column validated by the shared `userSettingsSchema` and changed through
`PATCH /users/me/settings`; two more keys (`messageSound`, `browserNotifications`) are reserved
for the chat follow-ups. Reads are now pushed to **every** member, the reader included, so the
reader's other tabs lower their badge (review L9).

## Amendment 2026-10-19: chat follow-ups (plan B3b)

- **Deleting a message.** The sender can take a message back at any age. It is a soft delete:
  `messages.deleted_at` is set, the text is cleared and the picture is discarded, but the row
  keeps its place so ordering, keyset cursors and read marks hold. Everyone sees "Message
  deleted" (the list snippet too, when it was the newest message); deleted messages count for
  nobody as unread. `DELETE /conversations/:id/messages/:messageId` answers the message as it is
  now, and `message:deleted` pushes the same to every member.
- **Group roles.** `conversation_members.role` (`admin` | `member`). The creator starts as admin
  (the migration backfills existing groups from `created_by_id`, falling back to the
  longest-standing member). Admins rename the group (`PATCH /conversations/:id`), remove people
  (`DELETE /conversations/:id/members/:userId`) and hand the role on or take it back
  (`PUT /conversations/:id/members/:userId/role`); demoting the last admin is refused. Anyone
  still adds people and leaves. When the last admin leaves, is removed or deletes their account,
  the longest-standing member is promoted (`promoteIfNoAdminSql`, run inside the same
  transaction). This supersedes the "no admin roles, no renaming, no removing others" line above.
- **System lines.** Membership changes and renames are written into the thread by the server as
  messages of `kind = system` with a small JSON subject (`system_meta`, the shared
  `systemLineSchema`: type, actor, people concerned, new title, with names as at the time so a
  line still reads after someone left). They are pushed like any message (`message:new`), move
  the conversation up the list and become its snippet, but count for nobody as unread, move no
  read mark, raise no chat bubble and no alert, and cannot be deleted.
- **List pagination.** `GET /conversations` is keyset-paginated on the activity stamp
  (`COALESCE(last_message_at, created_at)`, so a new group without messages sorts by its
  creation) and the id; the page's ids come from SQL and are hydrated afterwards. The web list
  is an infinite query and loads more on scroll.
- **Reading UX.** A "n new messages" pill when a push arrives while the reader is scrolled up;
  the unread total in the tab title (`(3) Messages · BeSo`, one owner for the title and one
  for the badge in `lib/document-title.ts`); a sound (Web Audio, no asset) and a browser
  `Notification` for messages that arrive while the tab is hidden, each behind its account
  preference (`messageSound`, `browserNotifications`). The permission is requested only from the
  Settings switch.

## Amendment 2026-10-20: chat extras (plan C5)

- **Editing a message.** The sender changes the text of a message that is neither deleted nor a
  system line (`PATCH /conversations/:id/messages/:messageId { content }`); the picture stays.
  The previous text is kept in `message_revisions` and `messages.edited_at` is stamped, on the
  pattern of posts and comments (`GET …/messages/:messageId/revisions`, members only); an
  unchanged text is a no-op. Everyone, the sender's other tabs included, gets the new copy as
  `message:updated` and replaces the old one in place: nothing moves, no read mark changes, no
  bubble or alert is raised, the list snippet follows. The web offers "Edit message" in the
  sender's message menu and edits in the bubble with the shared `InlineEditor`; "edited" opens
  the history (`EditedMarker`). Chat windows get it with the same `Thread`.
- **Reactions on messages.** `message_reactions(message_id, user_id, type, created_at)`, one
  per member and message, switching updates it (`PUT`/`DELETE …/messages/:messageId/reaction`,
  answering the message). Deleted messages and system lines take none. The message carries the
  **plain list** `reactions: [{ userId, type }]` rather than the per-viewer summary the plan
  named: a push is the same for every member, so each client derives counts and its own
  reaction from the list (`reactionSummaryOf`); threads are never ranked by reactions, so no
  counter is kept. The change travels as the same `message:updated`. On the web the picker sits
  in the bubble's hover toolbar (always visible on phones) and the pills below the bubble reuse
  the comments' `ReactionBar`; a reaction is optimistic, counts for nobody as unread and plays
  no sound.
- **Two more system lines.** `group_created` ("Alice created the group", written inside the
  creation transaction, so a new group's thread is never empty) and `admin_added` /
  `admin_removed` ("Alice made Bob an admin", "Bob removed Alice as admin", written with the
  role change and pushed like a rename's line).
- **The sound rule.** The message sound (`messageSound`) plays for every message from someone
  else that is not on screen in the receiving tab — hidden tab, or a visible tab where that
  conversation is neither the open thread nor an open chat window — which is exactly when a
  bubble appears or the Messages badge goes up. The browser `Notification` stays hidden-tab
  only: a visible tab shows the bubble instead. `subscribeToMessages` listeners now receive
  `{ onScreen }` with the message so the alerts and the bubbles agree.

## Amendment 2026-10-23: posts sent to chats, the newest chat opens by itself (owner's request, R5)

- **A message can carry a post.** "Send post" on every post card picks up to ten chats or people
  (recent chats first, a search over chats and members otherwise; someone with a direct chat is
  offered once, as that chat), takes an optional message and sends it to each as a message of its
  own: `sendMessageSchema.postId` on the same HTTP route and socket event, a person without a
  chat gets one through `ensureDirect` first, and what failed stays chosen for another try.
  Migration `shared_posts`: `messages.shared_post_id` (foreign key, `SET NULL` when the post is
  deleted) and `messages.shares_post`, which stays true so the bubble keeps a frame, the way
  `posts.was_quote` does for quotes (ADR 0017). The sender must be able to see the post (unknown
  → field error `postId`, a block between sender and author → 403 `BLOCKED`, as for a quote).
- **The message names the post, the members load it.** `message.sharedPost` is `{ id }`,
  `{ unavailable: true }` or null, not an embed: one push serves every member (amendment 3's
  reason for the plain reactions list), but who may see a post differs between them. Each client
  reads it through `GET /posts/:id` into the post page's cache (`postQueryOptions`), so the
  viewer's blocks apply, a 404 shows the same "This post is unavailable" frame as a deletion, and
  a like given on the post page shows in the chat too. The cost is one request per distinct post
  in a loaded thread, cached. Deleting the message clears the reference with the text and picture.
  The list snippet, the alert and the push say "Post" / "Sent a post" when there is no text; the
  export lists `sharedPostId`. Sending a post notifies nobody beyond the message itself.
- **Two panes open the newest chat.** On widths from `md` up, `/messages` redirects to the chat at
  the top of the list (newest activity), as Messenger's web app does, and reads it as a click
  would; only a member without a single conversation sees the empty pane with "New message" and
  "New group". On phones the list stays the page.

## Amendment 2026-10-23: replies (owner's request, R6)

- **A message can answer another one** of the same conversation: `sendMessageSchema.replyToId`
  (a member's message that is still there; another conversation's, a system line or a deleted
  one is a field error), stored as `messages.reply_to_id` (`SET NULL`) with `is_reply`, which
  stays true so a reply whose original left with its sender's account shows "Original message
  unavailable", the same pattern as `shares_post`.
- **The quote is the original as it is now.** `message.replyTo` carries the original's id,
  sender, the start of its text (`REPLY_EXCERPT_LENGTH`), what it carried besides text and
  whether it was deleted, read from the original at every read, so a thread loaded after an
  edit or a deletion quotes that; a client that has the original loaded prefers it, so an edit
  or a deletion pushed later shows in the quotes at once without the replies being pushed again.
  Unlike a shared post (amendment 2026-10-23 above), the same quote serves every member: they all
  see every message of the conversation. Deleting a reply clears its reference.
- **On the web** "Reply" sits in the bubble's hover toolbar and first in the press-and-hold
  actions; the composer shows "Replying to …" above the field (its description), cancelled with
  the button or Escape; the quote above the reply is a button that scrolls to the original and
  rings it, or says it is further up when that part of the history is not loaded.

## Amendment 2026-10-31: group pictures (owner's request, R11)

- **A group can have a picture.** `conversations.picture_key` (migration `group_pictures`) names
  an upload of the new kind `group`, framed like an avatar (1:1, 512², the `PROFILE_PICTURE_SIZES`
  entry the web cropper and the API preset share); the upload must be the caller's, as for a
  profile picture. Admins set it with `PUT /conversations/:id/picture { pictureKey }` and take it
  away with `DELETE /conversations/:id/picture`; both answer the conversation, write a system
  line (`picture_changed`, `picture_removed`) and push `conversation:update` the way a rename
  does; the same key again, or removing from a group without one, is a no-op.
  `conversation.pictureUrl` carries it and is null on direct threads.
- **Files follow the references.** The replaced or removed file is discarded at once; the last
  member leaving discards the picture with the group; `UploadsService.discard` and the orphan job
  count the column among the references; account erasure discards the pictures of the groups it
  deletes. The foreign key is `SET NULL`, so a picture leaves with the account of the member who
  uploaded it (ADR 0012 erases every file of a member) and the group shows the plain tile again.
- **On the web** `ConversationAvatar` shows the picture wherever a group is drawn (the list, the
  thread header, chat bubbles and windows, "Send post"). The members dialog offers admins a
  "Group picture" field, the shared `ImageField` and cropper, but every change is its own request
  (no Save button) and the thread reads "Alice changed the group picture". A picture at group
  creation is not offered yet (`BACKLOG.md`).

## Consequences

- The web client addresses threads by conversation id (`/messages/:conversationId`); `/messages/with/:username` resolves a person to their direct thread and redirects. Member lists, per-member read receipts and multi-person typing all derive from the conversation's `members`; a group's avatar is its own picture when an admin set one (amendment 2026-10-31), a tile otherwise.
- The conversations list is still capped at 100 and not paginated (unchanged from v2.0); pagination by `last_message_at` is possible later without a schema change.
- Presence and typing remain in-memory per API instance (ADR 0002's single-instance assumption still holds).
