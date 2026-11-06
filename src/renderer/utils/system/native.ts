import { APPLICATION } from '../../../shared/constants';
import type { INativeNotificationPayload } from '../../../shared/events';
import {
  getNativeNotificationId,
  NATIVE_NOTIFICATION_SUMMARY_ID,
  type NativeNotificationIcon,
} from '../../../shared/nativeNotifications';

import type { GitifyActivityKind, GitifyNotification } from '../../types';

import i18n from '../../i18n';
import { getAccountUUID } from '../auth/utils';

/**
 * Up to this many new notifications are posted as individual banners. Above
 * it, a single summary banner is posted instead so a large backlog (for
 * example after waking from sleep) doesn't flood Notification Center.
 */
export const MAX_INDIVIDUAL_NATIVE_NOTIFICATIONS = 5;

/** Longest comment excerpt shown in a banner body. */
export const MAX_NATIVE_BODY_LENGTH = 280;

/**
 * Collapse whitespace and cut long text to a banner-sized excerpt.
 *
 * @param text - The comment or review text.
 * @returns A single-line excerpt, ending in an ellipsis when it was cut.
 */
export function toBannerExcerpt(text: string): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= MAX_NATIVE_BODY_LENGTH) {
    return singleLine;
  }
  return `${singleLine.slice(0, MAX_NATIVE_BODY_LENGTH - 1).trimEnd()}…`;
}

/**
 * A comment or review counts as what triggered the notification only when it
 * happened this close to the notification's own update time. GitHub's
 * notification reason says why you follow a thread, not what just happened,
 * so this is how a review request is told apart from a later comment.
 */
export const ACTIVITY_MATCH_WINDOW_MS = 3 * 60 * 1000;

function describeActivity(kind: GitifyActivityKind, actor: string): string {
  switch (kind) {
    case 'APPROVED':
      return i18n.t('native.activity_approved', '{{actor}} approved', { actor });
    case 'CHANGES_REQUESTED':
      return i18n.t('native.activity_changes_requested', '{{actor}} requested changes', { actor });
    case 'DISMISSED':
      return i18n.t('native.activity_dismissed', '{{actor}} dismissed a review', { actor });
    case 'COMMENTED':
      return i18n.t('native.activity_reviewed', '{{actor}} reviewed', { actor });
    default:
      return i18n.t('native.activity_commented', '{{actor}} commented', { actor });
  }
}

function activityIcon(kind: GitifyActivityKind, byBot: boolean): NativeNotificationIcon {
  switch (kind) {
    case 'APPROVED':
      return 'pr-approved';
    case 'CHANGES_REQUESTED':
      return 'changes-requested';
    case 'comment':
      return byBot ? 'bot-comment' : 'issue-comment';
    default:
      return 'tekmetric-git';
  }
}

/**
 * Whether the latest comment or review is what this notification is about.
 *
 * @param notification - The notification to check.
 * @returns `true` when the activity happened within {@link ACTIVITY_MATCH_WINDOW_MS}.
 */
export function isActivityCurrent(notification: GitifyNotification): boolean {
  const activity = notification.subject.latestActivity;
  if (!activity) {
    return false;
  }
  if (!activity.at) {
    return true;
  }
  const distance = Math.abs(Date.parse(activity.at) - Date.parse(notification.updatedAt));
  return Number.isNaN(distance) || distance <= ACTIVITY_MATCH_WINDOW_MS;
}

function subjectLabel(notification: GitifyNotification): string {
  const number = notification.subject.number;
  const where = number
    ? `${notification.repository.name}#${number}`
    : notification.repository.fullName;
  return `${where} · ${notification.display.title}`;
}

/**
 * Build the structured payload for one notification.
 *
 * Banners read, in order of preference:
 * - CI: "CI failed: <workflow>" / "CI passed: <workflow>" with the branch.
 * - A comment or review that just happened: "@actor commented" /
 *   "@actor approved", then "repo#123 · PR title", then its text.
 * - A review request: "Your review was requested", then the PR and its author.
 * - A merged or closed PR: "PR merged" / "PR closed without merging".
 * - Anything else: the repository, reason and subject title.
 *
 * Each also names a badge icon for the main process to attach.
 *
 * @param notification - The notification to publish.
 * @returns The main-process payload.
 */
export function buildNativeNotificationPayload(
  notification: GitifyNotification,
): INativeNotificationPayload {
  const accountUUID = getAccountUUID(notification.account);
  const id = getNativeNotificationId(accountUUID, notification.id);
  const actionLabel = notification.unread
    ? i18n.t('notifications.mark_as_read', 'Mark as read')
    : undefined;
  const subject = notification.subject;
  const actor = subject.user?.login ?? subject.author?.login;
  const identifier = notification.display.identifier;
  const activity = subject.latestActivity;

  if (subject.type === 'CheckSuite' && subject.ciRun) {
    if (subject.state === 'SUCCESS' || subject.state === 'FAILURE') {
      const passed = subject.state === 'SUCCESS';
      const { workflow, branch } = subject.ciRun;
      return {
        id,
        title: passed
          ? i18n.t('native.ci_passed', 'CI passed: {{workflow}}', { workflow })
          : i18n.t('native.ci_failed', 'CI failed: {{workflow}}', { workflow }),
        subtitle: notification.repository.fullName,
        body: i18n.t('native.ci_branch', 'Branch {{branch}}', { branch }),
        actionLabel,
        icon: passed ? 'ci-checks-passed' : 'ci-checks-failed',
      };
    }
  }

  if (activity && actor && isActivityCurrent(notification)) {
    return {
      id,
      title: describeActivity(activity.kind, `@${actor}`),
      subtitle: subjectLabel(notification),
      body: activity.text ? toBannerExcerpt(activity.text) : notification.display.title,
      actionLabel,
      icon: activityIcon(activity.kind, subject.user?.type === 'Bot'),
    };
  }

  const isPullRequest = subject.type === 'PullRequest';
  const isFinished = subject.state === 'MERGED' || subject.state === 'CLOSED';

  if (isPullRequest && !isFinished && notification.reason.code === 'review_requested') {
    const author = subject.author?.login;
    return {
      id,
      title: i18n.t('native.review_requested', 'Your review was requested'),
      subtitle: subjectLabel(notification),
      body: author
        ? i18n.t('native.pull_request_by', 'Pull request by @{{author}}', { author })
        : notification.display.title,
      actionLabel,
      icon: 'review-requested',
    };
  }

  if (isPullRequest && isFinished) {
    const merged = subject.state === 'MERGED';
    return {
      id,
      title: merged
        ? i18n.t('native.pr_merged', 'PR merged')
        : i18n.t('native.pr_closed', 'PR closed without merging'),
      subtitle: subjectLabel(notification),
      body: subject.author
        ? i18n.t('native.pull_request_by', 'Pull request by @{{author}}', {
            author: subject.author.login,
          })
        : notification.display.title,
      actionLabel,
      icon: merged ? 'pr-merged' : 'pr-closed-without-merge',
    };
  }

  const context = [notification.reason.title, actor ? `@${actor}` : ''].filter(Boolean).join(' · ');
  const body =
    identifier && !notification.display.title.includes(identifier)
      ? `${notification.display.title} (${identifier})`
      : notification.display.title;

  return {
    id,
    title: notification.repository.fullName,
    subtitle: context || undefined,
    body,
    actionLabel,
    icon: 'tekmetric-git',
  };
}

/**
 * Publish new notifications: one banner each, up to
 * {@link MAX_INDIVIDUAL_NATIVE_NOTIFICATIONS}, otherwise a single summary.
 *
 * @param notifications - The new notifications to publish.
 * @returns The published payloads, so the host can track them for removal.
 */
export function raiseNativeNotification(
  notifications: GitifyNotification[],
): INativeNotificationPayload[] {
  if (notifications.length === 0) {
    return [];
  }

  if (notifications.length > MAX_INDIVIDUAL_NATIVE_NOTIFICATIONS) {
    const summary: INativeNotificationPayload = {
      id: NATIVE_NOTIFICATION_SUMMARY_ID,
      title: APPLICATION.NAME,
      body: i18n.t('native.summary_body_other', 'You have {{count}} notifications', {
        count: notifications.length,
      }),
      icon: 'tekmetric-git',
    };

    window.gitify.nativeNotifications.show(summary);

    return [summary];
  }

  const payloads = notifications.map(buildNativeNotificationPayload);

  for (const payload of payloads) {
    window.gitify.nativeNotifications.show(payload);
  }

  return payloads;
}
