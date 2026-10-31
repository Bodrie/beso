import type { Conversation } from '@beso/shared';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { ImageField } from '@/features/uploads/image-field';
import { useImageUpload } from '@/features/uploads/use-image-upload';
import { isApiClientError } from '@/lib/api/client';
import { useRemoveGroupPicture, useSetGroupPicture } from './use-conversations';

type GroupPictureFieldProps = { conversation: Conversation };

/**
 * The group's picture for its admins (the server checks): a chosen file goes through the
 * cropper in the avatar's frame, is uploaded as kind `group` and set on the group as soon as
 * the upload is done; "Remove" takes it away at once. Unlike the profile form there is no
 * Save: each change is its own request, and the thread gets a system line for it.
 */
export function GroupPictureField({ conversation }: GroupPictureFieldProps) {
  const upload = useImageUpload('group');
  const setPicture = useSetGroupPicture(conversation.id);
  const removePicture = useRemoveGroupPicture(conversation.id);
  const { clear } = upload;
  const { mutate: set } = setPicture;
  const readyKey = upload.state.status === 'ready' ? upload.state.upload.key : null;
  // One request per finished upload, however often this renders meanwhile.
  const sent = useRef<string | null>(null);

  useEffect(() => {
    if (readyKey === null || sent.current === readyKey) return;
    sent.current = readyKey;
    set(
      { pictureKey: readyKey },
      {
        // The fresh conversation is in the cache by now, so the field shows the new picture.
        onSuccess: clear,
        onError: (error) => {
          toast.error(
            isApiClientError(error)
              ? (error.fields.pictureKey ?? error.message)
              : 'Could not change the group picture',
          );
          clear();
        },
      },
    );
  }, [readyKey, set, clear]);

  return (
    <ImageField
      kind="group"
      label="Group picture"
      currentUrl={conversation.pictureUrl}
      upload={upload}
      removed={false}
      onRemovedChange={(removed) => {
        if (!removed || conversation.pictureUrl === null) return;
        removePicture.mutate(undefined, {
          onError: (error) =>
            toast.error(
              isApiClientError(error) ? error.message : 'Could not remove the group picture',
            ),
        });
      }}
    />
  );
}
