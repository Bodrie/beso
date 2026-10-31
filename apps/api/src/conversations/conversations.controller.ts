import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Conversation, MarkReadResult, Message, Paginated, Revision } from '@beso/shared';
import { ZodResponse } from 'nestjs-zod';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { CursorQueryDto, IdParamDto, UserIdParamDto } from '../common/params.dto.js';
import {
  ConversationDto,
  ConversationListDto,
  MarkReadResultDto,
  MessageDto,
  MessageListDto,
  RevisionListDto,
} from '../common/responses.dto.js';
import {
  AddMembersDto,
  ConversationsQueryDto,
  CreateGroupDto,
  EditMessageDto,
  MemberParamsDto,
  MessageParamsDto,
  MessageReactionDto,
  MessagesQueryDto,
  RenameGroupDto,
  SendMessageDto,
  SetGroupPictureDto,
  SetMemberRoleDto,
} from './conversations.dto.js';
import { ConversationsService } from './conversations.service.js';

@ApiTags('conversations')
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  @ZodResponse({ status: 200, type: ConversationListDto })
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: ConversationsQueryDto,
  ): Promise<Paginated<Conversation>> {
    return this.conversations.list(user.id, query);
  }

  @Post()
  @ZodResponse({ status: 201, type: ConversationDto })
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  createGroup(@CurrentUser() user: AuthUser, @Body() body: CreateGroupDto): Promise<Conversation> {
    return this.conversations.createGroup(user.id, body);
  }

  /** Idempotent: opens the direct thread with someone, creating it the first time. */
  @Put('direct/:userId')
  @ZodResponse({ status: 200, type: ConversationDto })
  ensureDirect(
    @CurrentUser() user: AuthUser,
    @Param() params: UserIdParamDto,
  ): Promise<Conversation> {
    return this.conversations.ensureDirect(user.id, params.userId);
  }

  @Get(':id')
  @ZodResponse({ status: 200, type: ConversationDto })
  get(@CurrentUser() user: AuthUser, @Param() params: IdParamDto): Promise<Conversation> {
    return this.conversations.get(user.id, params.id);
  }

  /** Admins rename a group; a system line tells the members. */
  @Patch(':id')
  @ZodResponse({ status: 200, type: ConversationDto })
  rename(
    @CurrentUser() user: AuthUser,
    @Param() params: IdParamDto,
    @Body() body: RenameGroupDto,
  ): Promise<Conversation> {
    return this.conversations.rename(user.id, params.id, body);
  }

  /** Admins give a group a picture (an upload of kind `group`); a system line tells the members. */
  @Put(':id/picture')
  @ZodResponse({ status: 200, type: ConversationDto })
  setPicture(
    @CurrentUser() user: AuthUser,
    @Param() params: IdParamDto,
    @Body() body: SetGroupPictureDto,
  ): Promise<Conversation> {
    return this.conversations.setPicture(user.id, params.id, body);
  }

  /** Admins take the picture away again; a group without one is a no-op. */
  @Delete(':id/picture')
  @ZodResponse({ status: 200, type: ConversationDto })
  removePicture(@CurrentUser() user: AuthUser, @Param() params: IdParamDto): Promise<Conversation> {
    return this.conversations.removePicture(user.id, params.id);
  }

  @Get(':id/messages')
  @ZodResponse({ status: 200, type: MessageListDto })
  history(
    @CurrentUser() user: AuthUser,
    @Param() params: IdParamDto,
    @Query() query: MessagesQueryDto,
  ): Promise<Paginated<Message>> {
    return this.conversations.history(user.id, params.id, query);
  }

  /** HTTP fallback for sending; delivery to open sockets happens through the gateway either way. */
  @Post(':id/messages')
  @ZodResponse({ status: 201, type: MessageDto })
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  send(
    @CurrentUser() user: AuthUser,
    @Param() params: IdParamDto,
    @Body() body: SendMessageDto,
  ): Promise<Message> {
    return this.conversations.send(user.id, params.id, body);
  }

  /** The sender takes a message back for everyone (soft delete; the row keeps its place). */
  @Delete(':id/messages/:messageId')
  @ZodResponse({ status: 200, type: MessageDto })
  deleteMessage(
    @CurrentUser() user: AuthUser,
    @Param() params: MessageParamsDto,
  ): Promise<Message> {
    return this.conversations.deleteMessage(user.id, params.id, params.messageId);
  }

  /** The sender changes the text; the previous one becomes a revision. */
  @Patch(':id/messages/:messageId')
  @ZodResponse({ status: 200, type: MessageDto })
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  editMessage(
    @CurrentUser() user: AuthUser,
    @Param() params: MessageParamsDto,
    @Body() body: EditMessageDto,
  ): Promise<Message> {
    return this.conversations.editMessage(user.id, params.id, params.messageId, body);
  }

  @Get(':id/messages/:messageId/revisions')
  @ZodResponse({ status: 200, type: RevisionListDto })
  messageRevisions(
    @CurrentUser() user: AuthUser,
    @Param() params: MessageParamsDto,
    @Query() query: CursorQueryDto,
  ): Promise<Paginated<Revision>> {
    return this.conversations.messageRevisions(user.id, params.id, params.messageId, query);
  }

  /** Sets or switches the caller's reaction; answers the message with its reactions. */
  @Put(':id/messages/:messageId/reaction')
  @ZodResponse({ status: 200, type: MessageDto })
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  react(
    @CurrentUser() user: AuthUser,
    @Param() params: MessageParamsDto,
    @Body() body: MessageReactionDto,
  ): Promise<Message> {
    return this.conversations.react(user.id, params.id, params.messageId, body.type);
  }

  @Delete(':id/messages/:messageId/reaction')
  @ZodResponse({ status: 200, type: MessageDto })
  unreact(@CurrentUser() user: AuthUser, @Param() params: MessageParamsDto): Promise<Message> {
    return this.conversations.unreact(user.id, params.id, params.messageId);
  }

  @Post(':id/read')
  @ZodResponse({ status: 200, type: MarkReadResultDto })
  markRead(@CurrentUser() user: AuthUser, @Param() params: IdParamDto): Promise<MarkReadResult> {
    return this.conversations.markRead(user.id, params.id);
  }

  @Post(':id/members')
  @ZodResponse({ status: 200, type: ConversationDto })
  addMembers(
    @CurrentUser() user: AuthUser,
    @Param() params: IdParamDto,
    @Body() body: AddMembersDto,
  ): Promise<Conversation> {
    return this.conversations.addMembers(user.id, params.id, body);
  }

  /** Declared before `:userId` so "me" is never parsed as an id. */
  @Delete(':id/members/me')
  @HttpCode(204)
  leave(@CurrentUser() user: AuthUser, @Param() params: IdParamDto): Promise<void> {
    return this.conversations.leave(user.id, params.id);
  }

  /** Admins only. */
  @Delete(':id/members/:userId')
  @HttpCode(204)
  removeMember(@CurrentUser() user: AuthUser, @Param() params: MemberParamsDto): Promise<void> {
    return this.conversations.removeMember(user.id, params.id, params.userId);
  }

  /** Admins only: make someone an admin, or an admin a member again (never the last one). */
  @Put(':id/members/:userId/role')
  @ZodResponse({ status: 200, type: ConversationDto })
  setRole(
    @CurrentUser() user: AuthUser,
    @Param() params: MemberParamsDto,
    @Body() body: SetMemberRoleDto,
  ): Promise<Conversation> {
    return this.conversations.setRole(user.id, params.id, params.userId, body.role);
  }
}
