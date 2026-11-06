import {
  mockGitHubCloudGitifyNotifications,
  mockSingleAccountNotifications,
} from '../../__mocks__/notifications-mocks';

import {
  getNativeNotificationId,
  NATIVE_NOTIFICATION_SUMMARY_ID,
} from '../../../shared/nativeNotifications';

import type { GitifyNotification } from '../../types';

import { getAccountUUID } from '../auth/utils';
import {
  buildNativeNotificationPayload,
  MAX_INDIVIDUAL_NATIVE_NOTIFICATIONS,
  MAX_NATIVE_BODY_LENGTH,
  raiseNativeNotification,
  toBannerExcerpt,
} from './native';

describe('renderer/utils/system/native.ts', () => {
  const notification = mockGitHubCloudGitifyNotifications[0];
  const accountUUID = getAccountUUID(notification.account);

  beforeEach(() => {
    vi.mocked(window.gitify.nativeNotifications.show).mockClear();
  });

  describe('buildNativeNotificationPayload', () => {
    it('builds the identity, context, formatted body, and action', () => {
      const payload = buildNativeNotificationPayload(notification);

      expect(payload.id).toBe(getNativeNotificationId(accountUUID, notification.id));
      expect(payload.title).toBe(notification.repository.fullName);
      expect(payload.subtitle).toBe(`Updated · @${notification.subject.user?.login}`);
      expect(payload.body).toBe(notification.display.title);
      expect(payload.actionLabel).toBe('Mark as read');
    });

    it('shows the latest comment text with who commented', () => {
      const payload = buildNativeNotificationPayload({
        ...notification,
        subject: {
          ...notification.subject,
          number: 42,
          latestActivity: { kind: 'comment', text: 'Can we\n  rename this?' },
        },
      });

      expect(payload.title).toBe(`@${notification.subject.user?.login} commented`);
      expect(payload.subtitle).toBe(
        `${notification.repository.name}#42 · ${notification.display.title}`,
      );
      expect(payload.body).toBe('Can we rename this?');
    });

    it.each([
      ['APPROVED', 'approved'],
      ['CHANGES_REQUESTED', 'requested changes'],
      ['DISMISSED', 'dismissed a review'],
      ['COMMENTED', 'reviewed'],
    ] as const)('describes a %s review', (kind, verb) => {
      const payload = buildNativeNotificationPayload({
        ...notification,
        subject: { ...notification.subject, latestActivity: { kind } },
      });

      expect(payload.title).toBe(`@${notification.subject.user?.login} ${verb}`);
      expect(payload.body).toBe(notification.display.title);
    });

    describe('icons and event banners', () => {
      const at = notification.updatedAt;
      const pr = (
        subject: Partial<GitifyNotification['subject']>,
        reason: Partial<GitifyNotification['reason']> = {},
      ): GitifyNotification => ({
        ...notification,
        reason: { ...notification.reason, ...reason },
        subject: { ...notification.subject, type: 'PullRequest', number: 7, ...subject },
      });

      it.each([
        ['comment', 'User', 'issue-comment'],
        ['comment', 'Bot', 'bot-comment'],
        ['APPROVED', 'User', 'pr-approved'],
        ['CHANGES_REQUESTED', 'User', 'changes-requested'],
        ['DISMISSED', 'User', 'review-dismissed'],
        ['COMMENTED', 'User', 'review-commented'],
      ] as const)('uses the right icon for a %s by a %s', (kind, type, icon) => {
        const payload = buildNativeNotificationPayload(
          pr({
            user: { ...notification.subject.user!, type },
            latestActivity: { kind, text: 'hi', at },
          }),
        );

        expect(payload.icon).toBe(icon);
      });

      it('treats an old comment on a review request as the review request', () => {
        const payload = buildNativeNotificationPayload(
          pr(
            {
              author: { ...notification.subject.user!, login: 'alex-dev' },
              latestActivity: { kind: 'comment', text: 'old', at: '2017-05-19T10:00:00Z' },
            },
            { code: 'review_requested', title: 'Review Requested' },
          ),
        );

        expect(payload.title).toBe('Your review was requested');
        expect(payload.subtitle).toBe(
          `${notification.repository.name}#7 · ${notification.display.title}`,
        );
        expect(payload.body).toBe('Pull request by @alex-dev');
        expect(payload.icon).toBe('review-requested');
      });

      it('still shows a fresh comment on a review-request thread as a comment', () => {
        const payload = buildNativeNotificationPayload(
          pr(
            { latestActivity: { kind: 'comment', text: 'new', at } },
            { code: 'review_requested', title: 'Review Requested' },
          ),
        );

        expect(payload.title).toBe(`@${notification.subject.user?.login} commented`);
        expect(payload.icon).toBe('issue-comment');
      });

      it.each([
        ['MERGED', 'PR merged', 'pr-merged'],
        ['CLOSED', 'PR closed without merging', 'pr-closed-without-merge'],
      ] as const)('announces a %s pull request', (state, title, icon) => {
        const payload = buildNativeNotificationPayload(pr({ state, latestActivity: undefined }));

        expect(payload.title).toBe(title);
        expect(payload.icon).toBe(icon);
      });

      it.each([
        ['SUCCESS', 'CI passed: CI', 'ci-checks-passed'],
        ['FAILURE', 'CI failed: CI', 'ci-checks-failed'],
      ] as const)('announces a CI run with state %s', (state, title, icon) => {
        const payload = buildNativeNotificationPayload({
          ...notification,
          subject: {
            ...notification.subject,
            type: 'CheckSuite',
            state,
            ciRun: { workflow: 'CI', branch: 'main' },
          },
        });

        expect(payload.title).toBe(title);
        expect(payload.subtitle).toBe(notification.repository.fullName);
        expect(payload.body).toBe('Branch main');
        expect(payload.icon).toBe(icon);
      });

      it('uses the bell for the stock banner', () => {
        expect(buildNativeNotificationPayload(notification).icon).toBe('notification');
      });

      it.each(['mention', 'team_mention'] as const)('uses the @ icon for a %s', (code) => {
        const payload = buildNativeNotificationPayload({
          ...notification,
          reason: { ...notification.reason, code },
        });

        expect(payload.icon).toBe('mentioned');
      });
    });

    it('cuts long comment text to a banner excerpt', () => {
      const excerpt = toBannerExcerpt('x'.repeat(MAX_NATIVE_BODY_LENGTH + 50));

      expect(excerpt).toHaveLength(MAX_NATIVE_BODY_LENGTH);
      expect(excerpt.endsWith('…')).toBe(true);
    });

    it('omits the action for a notification that is already read', () => {
      const payload = buildNativeNotificationPayload({ ...notification, unread: false });

      expect(payload.actionLabel).toBeUndefined();
    });

    it('handles a notification without an actor', () => {
      const payload = buildNativeNotificationPayload({
        ...notification,
        subject: { ...notification.subject, user: undefined, author: undefined },
      });

      expect(payload.subtitle).toBe(notification.reason.title);
    });

    it('appends an identifier not already in the display title', () => {
      const payload = buildNativeNotificationPayload({
        ...notification,
        display: { ...notification.display, title: 'A title without a number', identifier: '#123' },
      });

      expect(payload.body).toContain('#123');
    });
  });

  describe('raiseNativeNotification', () => {
    it('publishes one individual notification for one item', () => {
      const published = raiseNativeNotification([notification]);

      expect(published).toHaveLength(1);
      expect(window.gitify.nativeNotifications.show).toHaveBeenCalledWith(
        expect.objectContaining({
          id: getNativeNotificationId(accountUUID, notification.id),
          actionLabel: 'Mark as read',
        }),
      );
    });

    it('publishes one banner per item for a small batch', () => {
      const notifications = mockSingleAccountNotifications[0].notifications.slice(0, 1);
      const second = { ...notification, id: 'second', order: 1 };

      const published = raiseNativeNotification([...notifications, second]);

      expect(published).toHaveLength(2);
      expect(window.gitify.nativeNotifications.show).toHaveBeenCalledTimes(2);
      expect(published.map((p) => p.id)).not.toContain(NATIVE_NOTIFICATION_SUMMARY_ID);
    });

    it('publishes one count-only summary above the individual limit', () => {
      const many = Array.from({ length: MAX_INDIVIDUAL_NATIVE_NOTIFICATIONS + 1 }, (_, i) => ({
        ...notification,
        id: `n${i}`,
        order: i,
      }));

      const published = raiseNativeNotification(many);

      expect(published).toHaveLength(1);
      expect(window.gitify.nativeNotifications.show).toHaveBeenCalledWith(
        expect.objectContaining({
          id: NATIVE_NOTIFICATION_SUMMARY_ID,
          title: 'Gitify',
          body: `You have ${MAX_INDIVIDUAL_NATIVE_NOTIFICATIONS + 1} notifications`,
          icon: 'summary',
        }),
      );
      expect(published[0]).not.toHaveProperty('actionLabel');
    });

    it('does nothing for an empty batch', () => {
      expect(raiseNativeNotification([])).toEqual([]);
      expect(window.gitify.nativeNotifications.show).not.toHaveBeenCalled();
    });
  });
});
