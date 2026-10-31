import { GROUP_MAX_MEMBERS } from '@beso/shared';
import type { Conversation, UserSummary } from '@beso/shared';
import { LogOutIcon, MoreHorizontalIcon, PencilIcon, UserPlusIcon } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { UserAvatar } from '@/components/user-avatar';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useCurrentUser } from '@/features/auth/current-user';
import { isApiClientError } from '@/lib/api/client';
import { useChat } from './chat-context';
import { isAdmin } from './conversation-display';
import { GroupPictureField } from './group-picture-field';
import { GroupTitleEditor } from './group-title-editor';
import { PeoplePicker } from './people-picker';
import { PresenceDot } from './presence-dot';
import {
  useAddMembers,
  useLeaveGroup,
  useRemoveMember,
  useSetMemberRole,
} from './use-conversations';

type GroupMembersDialogProps = { conversation: Conversation; children: ReactNode };

const errorMessage = (error: unknown, fallback: string, field?: string): string =>
  isApiClientError(error) ? ((field && error.fields[field]) ?? error.message) : fallback;

/**
 * Who is in the group, with a way to bring people in and a way out. Admins also rename the
 * group, give it a picture, remove people and hand the admin role on (the server refuses
 * demoting the last one).
 */
export function GroupMembersDialog({ conversation, children }: GroupMembersDialogProps) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState<UserSummary | null>(null);
  const me = useCurrentUser();
  const { isOnline } = useChat();
  const navigate = useNavigate();
  const addMembers = useAddMembers(conversation.id);
  const leaveGroup = useLeaveGroup();
  const removeMember = useRemoveMember(conversation.id);
  const setRole = useSetMemberRole(conversation.id);
  const memberIds = conversation.members.map((member) => member.user.id);
  const admin = isAdmin(conversation, me.id);
  const admins = conversation.members.filter((member) => member.role === 'admin').length;
  const pickerId = useId();

  const add = (userId: string) => {
    if (conversation.members.length >= GROUP_MAX_MEMBERS) {
      toast.error(`A group can have at most ${GROUP_MAX_MEMBERS} members`);
      return;
    }
    addMembers.mutate(
      { userIds: [userId] },
      {
        onError: (error) =>
          toast.error(errorMessage(error, 'Could not add that person', 'userIds')),
      },
    );
  };

  const leave = () =>
    leaveGroup.mutate(conversation.id, {
      onSuccess: () => {
        setOpen(false);
        void navigate('/messages');
      },
      onError: (error) => toast.error(errorMessage(error, 'Could not leave the group')),
    });

  const remove = (user: UserSummary) =>
    removeMember.mutate(user.id, {
      onSuccess: () => toast.success(`${user.name} was removed from the group`),
      onError: (error) => toast.error(errorMessage(error, 'Could not remove that person')),
    });

  const changeRole = (user: UserSummary, role: 'admin' | 'member') =>
    setRole.mutate(
      { userId: user.id, role },
      {
        onError: (error) => toast.error(errorMessage(error, 'Could not change the role', 'role')),
      },
    );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setAdding(false);
          setRenaming(false);
        }
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{conversation.title}</DialogTitle>
          <DialogDescription>
            {conversation.members.length} {conversation.members.length === 1 ? 'member' : 'members'}
          </DialogDescription>
        </DialogHeader>
        {admin ? <GroupPictureField conversation={conversation} /> : null}
        {renaming ? (
          <GroupTitleEditor conversation={conversation} onDone={() => setRenaming(false)} />
        ) : null}
        <ul aria-label="Members" className="max-h-64 space-y-1 overflow-y-auto" tabIndex={0}>
          {conversation.members.map(({ user, role }) => (
            <li key={user.id} className="flex items-center gap-3 rounded-lg px-2 py-1.5">
              <span className="relative shrink-0">
                <UserAvatar user={user} size="lg" />
                <PresenceDot online={isOnline(user.id)} />
              </span>
              <span className="min-w-0 flex-1">
                <Link
                  to={`/u/${user.username}`}
                  className="block truncate text-sm font-semibold hover:underline"
                >
                  {user.name}
                  {user.id === me.id ? (
                    <span className="text-muted-foreground font-normal"> (you)</span>
                  ) : null}
                </Link>
                <span className="text-muted-foreground block truncate text-xs">
                  {role === 'admin' ? 'Admin' : `@${user.username}`}
                </span>
              </span>
              {admin && user.id !== me.id ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`Options for ${user.name}`}>
                      <MoreHorizontalIcon />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {role === 'admin' ? (
                      <DropdownMenuItem
                        disabled={admins <= 1}
                        onSelect={() => changeRole(user, 'member')}
                      >
                        Remove as admin
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onSelect={() => changeRole(user, 'admin')}>
                        Make admin
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(user)}>
                      Remove from group
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </li>
          ))}
        </ul>
        {adding ? (
          <PeoplePicker
            id={pickerId}
            searchLabel="Search people to add"
            excludeIds={memberIds}
            focusOnMount
            onPick={(user) => add(user.id)}
          />
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={adding}
              aria-controls={adding ? pickerId : undefined}
              onClick={() => setAdding((value) => !value)}
            >
              <UserPlusIcon /> Add people
            </Button>
            {admin ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-expanded={renaming}
                onClick={() => setRenaming((value) => !value)}
              >
                <PencilIcon /> Rename
              </Button>
            ) : null}
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button type="button" variant="outline" size="sm">
                <LogOutIcon /> Leave group
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Leave {conversation.title}?</AlertDialogTitle>
                <AlertDialogDescription>
                  You will stop receiving its messages. Someone in the group can add you again.
                  {admin && admins === 1 && conversation.members.length > 1
                    ? ' You are the only admin: the longest-standing member takes over.'
                    : ''}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Stay</AlertDialogCancel>
                <AlertDialogAction onClick={leave} disabled={leaveGroup.isPending}>
                  Leave
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </DialogContent>
      <AlertDialog open={removing !== null} onOpenChange={(next) => !next && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name} from the group?</AlertDialogTitle>
            <AlertDialogDescription>
              They stop receiving its messages. Anyone in the group can add them again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction
              disabled={removeMember.isPending}
              onClick={() => {
                if (removing) remove(removing);
                setRemoving(null);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
