import {
  addMembersSchema,
  conversationsQuerySchema,
  createGroupSchema,
  editMessageSchema,
  messageReactionInputSchema,
  messagesQuerySchema,
  renameGroupSchema,
  sendMessageSchema,
  setGroupPictureSchema,
  setMemberRoleSchema,
  uuidSchema,
} from '@beso/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export class SendMessageDto extends createZodDto(sendMessageSchema) {}
export class EditMessageDto extends createZodDto(editMessageSchema) {}
export class MessageReactionDto extends createZodDto(messageReactionInputSchema) {}
export class MessagesQueryDto extends createZodDto(messagesQuerySchema) {}
export class ConversationsQueryDto extends createZodDto(conversationsQuerySchema) {}
export class CreateGroupDto extends createZodDto(createGroupSchema) {}
export class AddMembersDto extends createZodDto(addMembersSchema) {}
export class RenameGroupDto extends createZodDto(renameGroupSchema) {}
export class SetMemberRoleDto extends createZodDto(setMemberRoleSchema) {}
export class SetGroupPictureDto extends createZodDto(setGroupPictureSchema) {}
export class MessageParamsDto extends createZodDto(
  z.object({ id: uuidSchema, messageId: uuidSchema }),
) {}
export class MemberParamsDto extends createZodDto(
  z.object({ id: uuidSchema, userId: uuidSchema }),
) {}
