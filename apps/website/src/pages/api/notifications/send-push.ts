import { z } from "zod";

import { type NotificationUrgency, prisma } from "@alveusgg/database";

import { env } from "@/env";

import { updateNotificationPushStatus } from "@/server/db/notifications";
import { markPushSubscriptionAsDeleted } from "@/server/db/push-subscriptions";
import { createTokenProtectedApiHandler } from "@/server/utils/api";
import { sendWebPushNotification } from "@/server/web-push";
import {
  WEB_PUSH_MAX_TTL,
  getWebPushUrgency,
  isNotificationUrgency,
} from "@/server/web-push/constants";

import {
  badgeUrl,
  defaultTag,
  defaultTitle,
  iconUrl,
} from "@/data/notifications";

import type { NotificationPayload } from "@/utils/notification-payload";

export const config = {
  maxDuration: 60, // 60 Seconds is the maximum duration allowed in Hobby Plan
};

export type SendPushOptions = z.infer<typeof sendPushSchema>;

const sendPushSchema = z.object({
  attempt: z.number().optional(),
  notificationId: z.cuid(),
  subscriptionId: z.cuid(),
  expiresAt: z.number(),
  title: z.string().optional(),
  message: z.string(),
  tag: z.string().optional(),
  imageUrl: z.string().optional(),
  urgency: z
    .string()
    .refine((value) => isNotificationUrgency(value), "invalid urgency")
    .transform((value) => value as NotificationUrgency),
});

export default createTokenProtectedApiHandler(
  sendPushSchema,
  async (options) => {
    let delivered = false;
    let expired = false;

    const subscription = await prisma.pushSubscription.findUnique({
      where: { id: options.subscriptionId },
    });

    if (!subscription || subscription.deletedAt !== null) {
      return true;
    }

    const expiresAt = new Date(options.expiresAt);
    const push = await prisma.notificationPush.upsert({
      where: {
        notificationId_subscriptionId: {
          notificationId: options.notificationId,
          subscriptionId: options.subscriptionId,
        },
      },
      create: {
        processingStatus: "IN_PROGRESS",
        attempts: 1,
        notification: { connect: { id: options.notificationId } },
        subscription: { connect: { id: options.subscriptionId } },
        user: subscription.userId
          ? { connect: { id: subscription.userId } }
          : undefined,
        expiresAt,
      },
      update: {
        processingStatus: "IN_PROGRESS",
        attempts: options.attempt || 1,
      },
    });

    const now = new Date();
    try {
      if (
        options.expiresAt < now.getTime() ||
        !subscription.p256dh ||
        !subscription.auth
      ) {
        await updateNotificationPushStatus({
          processingStatus: "DONE",
          notificationId: options.notificationId,
          subscriptionId: options.subscriptionId,
          failedAt: now,
        });
        return true;
      }

      const ttl = Math.min(
        WEB_PUSH_MAX_TTL,
        Math.max(
          0,
          Math.round((push.expiresAt.getTime() - now.getTime()) / 1000),
        ),
      );

      const res = await sendWebPushNotification(
        {
          endpoint: subscription.endpoint,
          keys: {
            p256dh: subscription.p256dh,
            auth: subscription.auth,
          },
        },
        JSON.stringify({
          title: options.title || defaultTitle,
          options: {
            body: options.message,
            renotify: true,
            requireInteraction: true,
            silent: false,
            tag: options.tag || defaultTag,
            data: {
              notificationId: options.notificationId,
              subscriptionId: options.subscriptionId,
            },
            image: options.imageUrl,
            dir: env.PUSH_TEXT_DIR,
            lang: env.PUSH_LANG,
            icon: iconUrl,
            badge: badgeUrl,
          },
        } satisfies NotificationPayload),
        {
          TTL: ttl,
          headers: {
            Urgency: getWebPushUrgency(options.urgency),
          },
        },
      );

      if (res.statusCode) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          delivered = true;
        } else if (res.statusCode === 410) {
          expired = true;
          // 410 Gone = subscription expired or unsubscribed
          await markPushSubscriptionAsDeleted(options.subscriptionId);
        }
      }
    } catch (e) {
      console.error("Failed to send push notification", e);
    }

    const status =
      delivered ||
      expired ||
      (options.attempt && options.attempt >= env.PUSH_MAX_ATTEMPTS)
        ? "DONE"
        : "PENDING";

    await updateNotificationPushStatus({
      processingStatus: status,
      notificationId: options.notificationId,
      subscriptionId: options.subscriptionId,
      deliveredAt: delivered ? now : undefined,
      failedAt: delivered ? undefined : now,
    });

    return true;
  },
);
