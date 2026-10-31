import {
  accountExportSchema,
  activityListSchema,
  adminReportListSchema,
  adminReportSchema,
  commentListSchema,
  commentSchema,
  confirmEmailChangeResponseSchema,
  conversationListSchema,
  conversationSchema,
  inviteLookupSchema,
  inviteSchema,
  markReadResultSchema,
  meResponseSchema,
  memberListSchema,
  messageListSchema,
  messageSchema,
  notificationListSchema,
  postListSchema,
  postSchema,
  pushConfigSchema,
  reactionSummarySchema,
  reportSchema,
  revisionListSchema,
  sessionListSchema,
  trendingTagListSchema,
  unreadCountSchema,
  uploadResponseSchema,
  voiceUploadResponseSchema,
  userListSchema,
  userPublicSchema,
  verifyEmailResponseSchema,
} from '@beso/shared';
import {
  achievementListSchema,
  achievementStatsSchema,
  myAchievementsSchema,
} from '@beso/shared/achievements';
import { createZodDto } from 'nestjs-zod';

/*
 * Response shapes for `@ZodResponse({ status, type })`, one per shared schema the web parses.
 * The serializer parses every answer with them (unknown keys are dropped; a mismatch is a
 * logged 500), and OpenAPI documents them. Several modules answer the same shape, so they
 * live here rather than in the modules' request DTO files.
 */

// Accounts and sessions
export class MeResponseDto extends createZodDto(meResponseSchema) {}
export class VerifyEmailResponseDto extends createZodDto(verifyEmailResponseSchema) {}
export class ConfirmEmailChangeResponseDto extends createZodDto(confirmEmailChangeResponseSchema) {}
export class SessionListDto extends createZodDto(sessionListSchema) {}
export class AccountExportDto extends createZodDto(accountExportSchema) {}
export class InviteDto extends createZodDto(inviteSchema) {}
export class InviteLookupDto extends createZodDto(inviteLookupSchema) {}
export class AchievementListDto extends createZodDto(achievementListSchema) {}
export class MyAchievementsDto extends createZodDto(myAchievementsSchema) {}
export class AchievementStatsDto extends createZodDto(achievementStatsSchema) {}

// People
export class UserPublicDto extends createZodDto(userPublicSchema) {}
export class UserListDto extends createZodDto(userListSchema) {}
/** People in the blocked and muted lists (summaries, not profiles). */
export class MemberListDto extends createZodDto(memberListSchema) {}

// Posts, comments, tags
export class PostDto extends createZodDto(postSchema) {}
export class PostListDto extends createZodDto(postListSchema) {}
export class RevisionListDto extends createZodDto(revisionListSchema) {}
export class CommentDto extends createZodDto(commentSchema) {}
export class CommentListDto extends createZodDto(commentListSchema) {}
export class ReactionSummaryDto extends createZodDto(reactionSummarySchema) {}
export class TrendingTagListDto extends createZodDto(trendingTagListSchema) {}
export class UploadResponseDto extends createZodDto(uploadResponseSchema) {}
export class VoiceUploadResponseDto extends createZodDto(voiceUploadResponseSchema) {}
export class PushConfigDto extends createZodDto(pushConfigSchema) {}

// Activity and notifications
export class ActivityListDto extends createZodDto(activityListSchema) {}
export class NotificationListDto extends createZodDto(notificationListSchema) {}
export class UnreadCountDto extends createZodDto(unreadCountSchema) {}

// Conversations
export class ConversationDto extends createZodDto(conversationSchema) {}
export class ConversationListDto extends createZodDto(conversationListSchema) {}
export class MessageDto extends createZodDto(messageSchema) {}
export class MessageListDto extends createZodDto(messageListSchema) {}
export class MarkReadResultDto extends createZodDto(markReadResultSchema) {}

// Moderation
export class ReportDto extends createZodDto(reportSchema) {}
export class AdminReportDto extends createZodDto(adminReportSchema) {}
export class AdminReportListDto extends createZodDto(adminReportListSchema) {}
