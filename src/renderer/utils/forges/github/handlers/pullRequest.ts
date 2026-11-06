import type { FC } from 'react';

import type { OcticonProps } from '@primer/octicons-react';
import {
  GitMergeIcon,
  GitMergeQueueIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
} from '@primer/octicons-react';

import { differenceInMilliseconds } from 'date-fns/differenceInMilliseconds';

import {
  type Account,
  type GitifyActivityKind,
  type GitifyCheckSummary,
  type GitifyNotification,
  type GitifyPullRequestReviewer,
  type GitifyPullRequestState,
  type GitifySubject,
  IconColor,
  type Link,
  type ReviewRequestType,
} from '../../../../types';

import { fetchPullByNumber } from '../client';
import type {
  AuthorFieldsFragment,
  CheckRunState,
  PullRequestDetailsFragment,
  PullRequestReviewFieldsFragment,
  PullRequestReviewThreadConnectionFieldsFragment,
  StatusState,
} from '../graphql/generated/graphql';
import { formatGitHubNotificationUser } from '../users';
import { DefaultHandler, defaultHandler } from './default';
import { getNotificationAuthor } from './utils';

type PullRequestActivity = {
  author: AuthorFieldsFragment;
  timestamp: string;
  url: Link;
  kind: GitifyActivityKind;
  text?: string;
  comment?: NonNullable<NonNullable<PullRequestDetailsFragment['comments']['nodes']>[number]>;
};

class PullRequestHandler extends DefaultHandler {
  override readonly supportsMergedQueryEnrichment = true;

  override async enrich(
    notification: GitifyNotification,
    fetchedData?: PullRequestDetailsFragment,
  ): Promise<Partial<GitifySubject>> {
    const pr = fetchedData ?? (await fetchPullByNumber(notification)).repository?.pullRequest;

    if (!pr) {
      return {};
    }

    let prState: GitifyPullRequestState = pr.state;
    if (pr.isDraft) {
      prState = 'DRAFT';
    } else if (pr.isInMergeQueue) {
      prState = 'MERGE_QUEUE';
    }

    const prComment = pr.comments?.nodes?.[0];
    const activity = getClosestPullRequestActivity(notification.updatedAt, pr);
    // Only a comment or review that happened with the notification is what the
    // notification is about; otherwise (a review request, merge or close) the
    // link and banner point at the pull request itself.
    const currentActivity =
      activity && isCurrentActivity(notification.updatedAt, activity.timestamp)
        ? activity
        : undefined;

    const author = getNotificationAuthor([pr.author]);
    const commenter = getNotificationAuthor([prComment?.author]);
    const prUser = getNotificationAuthor([activity?.author]) ?? author;

    const reviewers = getPullRequestReviewers(
      notification.account,
      (pr.reviews?.nodes?.filter(Boolean) ?? []) as PullRequestReviewFieldsFragment[],
      pr.reviewThreads,
    );

    const reviewRequested = getReviewRequestTypes(
      pr.reviewRequests?.nodes?.filter(Boolean) ?? [],
      notification.account?.user?.login,
    );

    const prReactionCount = activity?.comment?.reactions.totalCount ?? pr.reactions.totalCount;
    const prReactionGroup = activity?.comment?.reactionGroups ?? pr.reactionGroups;

    return {
      number: pr.number,
      state: prState,
      user: prUser,
      author: author,
      commenter: commenter,
      reviewRequested,
      reviewers,
      reviewDecision: prState === 'OPEN' ? (pr.reviewDecision ?? undefined) : undefined,
      commentCount: pr.comments.totalCount,
      labels:
        pr.labels?.nodes?.filter(Boolean).map((label) => ({
          name: label!.name,
          color: label!.color,
        })) ?? [],
      labelCount: pr.labels?.totalCount,
      isStacked: pr.stackEntry ? true : undefined,
      stackPosition: pr.stackEntry?.position,
      stackDepth: pr.stackEntry?.stack?.size,
      linkedIssues: pr.closingIssuesReferences?.nodes
        ?.filter(Boolean)
        .map((issue) => ({ number: issue!.number, url: issue!.url })),
      milestone: pr.milestone ?? undefined,
      htmlUrl: currentActivity?.url ?? pr.url,
      latestActivity: currentActivity
        ? { kind: currentActivity.kind, text: currentActivity.text, at: currentActivity.timestamp }
        : undefined,
      reactionsCount: prReactionCount,
      reactionGroups: prReactionGroup ?? undefined,
      checks: getCheckSummary(pr.statusCheckRollup),
    };
  }

  override iconType(notification: GitifyNotification): FC<OcticonProps> {
    switch (notification.subject.state as GitifyPullRequestState) {
      case 'DRAFT':
        return GitPullRequestDraftIcon;
      case 'CLOSED':
        return GitPullRequestClosedIcon;
      case 'MERGE_QUEUE':
        return GitMergeQueueIcon;
      case 'MERGED':
        return GitMergeIcon;
      default:
        return GitPullRequestIcon;
    }
  }

  override iconColor(notification: GitifyNotification): IconColor {
    switch (notification.subject.state as GitifyPullRequestState) {
      case 'OPEN':
        return IconColor.GREEN;
      case 'CLOSED':
        return IconColor.RED;
      case 'MERGE_QUEUE':
        return IconColor.YELLOW;
      case 'MERGED':
        return IconColor.PURPLE;
      default:
        return defaultHandler.iconColor(notification);
    }
  }

  override defaultUrl(notification: GitifyNotification): Link {
    const url = new URL(defaultHandler.defaultUrl(notification));
    url.pathname += '/pulls';
    return url.href as Link;
  }
}

export const pullRequestHandler = new PullRequestHandler();

/**
 * A comment or review counts as what triggered a notification only when it
 * happened this close to the notification's own update time. GitHub's
 * notification reason says why you follow a thread, not what just happened,
 * so this is how a review request is told apart from an earlier comment.
 */
export const ACTIVITY_MATCH_WINDOW_MS = 3 * 60 * 1000;

/**
 * Whether a comment or review happened together with a notification.
 *
 * @param notificationUpdatedAt - The notification's update time (ISO 8601).
 * @param activityTimestamp - When the comment was updated or review submitted.
 * @returns `true` within {@link ACTIVITY_MATCH_WINDOW_MS}, or when a time can't be parsed.
 */
export function isCurrentActivity(
  notificationUpdatedAt: string,
  activityTimestamp: string,
): boolean {
  const distance = Math.abs(Date.parse(activityTimestamp) - Date.parse(notificationUpdatedAt));
  return Number.isNaN(distance) || distance <= ACTIVITY_MATCH_WINDOW_MS;
}

export function getClosestPullRequestActivity(
  notificationUpdatedAt: string,
  pullRequest: PullRequestDetailsFragment,
): PullRequestActivity | undefined {
  const activities: PullRequestActivity[] = [];

  for (const comment of pullRequest.comments.nodes ?? []) {
    if (!comment) {
      continue;
    }

    if (comment.author && comment.updatedAt && comment.url) {
      activities.push({
        author: comment.author,
        timestamp: comment.updatedAt,
        url: comment.url,
        kind: 'comment',
        text: nonEmptyText(comment.bodyText),
        comment,
      });
    }
  }

  for (const review of pullRequest.reviews?.nodes ?? []) {
    if (!review) {
      continue;
    }

    if (review.author && review.submittedAt && review.url) {
      activities.push({
        author: review.author,
        timestamp: review.submittedAt,
        url: review.url,
        kind: review.state,
        // A review with no summary text often still has inline comments.
        text: nonEmptyText(review.bodyText) ?? nonEmptyText(review.comments?.nodes?.[0]?.bodyText),
      });
    }
  }

  return activities.reduce<PullRequestActivity | undefined>((closest, activity) => {
    const distance = Math.abs(differenceInMilliseconds(activity.timestamp, notificationUpdatedAt));
    if (Number.isNaN(distance)) {
      return closest;
    }

    if (!closest) {
      return activity;
    }

    const closestDistance = Math.abs(
      differenceInMilliseconds(closest.timestamp, notificationUpdatedAt),
    );
    return distance < closestDistance ? activity : closest;
  }, undefined);
}

type CheckOutcome = 'passed' | 'failed' | 'pending';

const checkRunOutcomes: Record<CheckRunState, CheckOutcome> = {
  SUCCESS: 'passed',
  NEUTRAL: 'passed',
  SKIPPED: 'passed',
  COMPLETED: 'passed',
  FAILURE: 'failed',
  CANCELLED: 'failed',
  TIMED_OUT: 'failed',
  ACTION_REQUIRED: 'failed',
  STARTUP_FAILURE: 'failed',
  STALE: 'failed',
  QUEUED: 'pending',
  IN_PROGRESS: 'pending',
  PENDING: 'pending',
  WAITING: 'pending',
};

const statusContextOutcomes: Record<StatusState, CheckOutcome> = {
  SUCCESS: 'passed',
  FAILURE: 'failed',
  ERROR: 'failed',
  PENDING: 'pending',
  EXPECTED: 'pending',
};

export function getCheckSummary(
  rollup: PullRequestDetailsFragment['statusCheckRollup'],
): GitifyCheckSummary | undefined {
  if (!rollup) {
    return undefined;
  }

  const summary: GitifyCheckSummary = {
    state: 'PENDING',
    passed: 0,
    failed: 0,
    pending: 0,
    total: 0,
  };

  const counts = [
    ...(rollup.contexts.checkRunCountsByState ?? []).map(({ state, count }) => ({
      outcome: checkRunOutcomes[state] ?? 'pending',
      count,
    })),
    ...(rollup.contexts.statusContextCountsByState ?? []).map(({ state, count }) => ({
      outcome: statusContextOutcomes[state] ?? 'pending',
      count,
    })),
  ];

  for (const { outcome, count } of counts) {
    summary[outcome] += count;
    summary.total += count;
  }

  if (!summary.total) {
    return undefined;
  }

  if (summary.failed) {
    summary.state = 'FAILURE';
  } else if (!summary.pending) {
    summary.state = 'SUCCESS';
  }

  return summary;
}

export function getReviewRequestTypes(
  nodes: NonNullable<NonNullable<PullRequestDetailsFragment['reviewRequests']>['nodes']>,
  currentUserLogin: string | undefined,
): ReviewRequestType[] {
  if (!nodes.length || !currentUserLogin) {
    return [];
  }

  const types = new Set<ReviewRequestType>();

  for (const node of nodes) {
    if (!node?.requestedReviewer) {
      continue;
    }

    if (
      node.requestedReviewer.__typename === 'User' &&
      node.requestedReviewer.login === currentUserLogin
    ) {
      types.add('direct');
    } else if (node.requestedReviewer.__typename === 'Team') {
      types.add('team');
    }
  }

  return Array.from(types);
}

export function getPullRequestReviewers(
  account: Account,
  reviews: (Pick<PullRequestReviewFieldsFragment, 'state' | 'author'> & {
    submittedAt?: string | null;
  })[],
  threadConnection?: PullRequestReviewThreadConnectionFieldsFragment,
): GitifyPullRequestReviewer[] {
  const reviewers = new Map<
    string,
    { reviewer: GitifyPullRequestReviewer; submittedAt?: string | null }
  >();

  // GitHub no longer guarantees the reviews connection is returned in creation
  // order, so sort by submission time (oldest first) to make the "newest wins"
  // selection below deterministic regardless of the connection ordering.
  const sortedReviews = [...reviews].sort((a, b) => {
    const at = a.submittedAt ?? '';
    const bt = b.submittedAt ?? '';
    if (at < bt) {
      return -1;
    }
    if (at > bt) {
      return 1;
    }
    return 0;
  });

  for (const review of sortedReviews) {
    const user = review.author?.login;
    if (!user) {
      continue;
    }

    const existingEntry = reviewers.get(user);
    const existingTimestamp = existingEntry?.submittedAt;
    const reviewTimestamp = review.submittedAt;
    const isNewerReview =
      !existingEntry ||
      (reviewTimestamp && (!existingTimestamp || reviewTimestamp > existingTimestamp)) ||
      (!reviewTimestamp && !existingTimestamp);

    if (isNewerReview) {
      const author = getNotificationAuthor([review.author]);
      reviewers.set(user, {
        reviewer: {
          user: author ? formatGitHubNotificationUser(account, author) : user,
          state: review.state,
          threads: existingEntry?.reviewer.threads ?? { resolved: 0, total: 0 },
        },
        submittedAt: reviewTimestamp,
      });
    }
  }

  for (const thread of threadConnection?.nodes ?? []) {
    if (!thread) {
      continue;
    }

    const user = thread.comments.nodes?.[0]?.author?.login ?? 'Unknown reviewer';
    const entry = reviewers.get(user) ?? {
      reviewer: { user, threads: { resolved: 0, total: 0 } },
    };
    entry.reviewer.threads.total += 1;
    entry.reviewer.threads.resolved += Number(thread.isResolved);
    reviewers.set(user, entry);
  }

  return Array.from(reviewers.values())
    .map(({ reviewer }) => reviewer)
    .sort((a, b) => a.user.localeCompare(b.user));
}

function nonEmptyText(text: string | null | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? trimmed : undefined;
}
