import { waitUntil } from "@vercel/functions";
import { z } from "zod";

import { prisma } from "@alveusgg/database";

import { createTokenProtectedApiHandler } from "@/server/utils/api";
import { callEndpoint } from "@/server/utils/queue";

import type { SendPushOptions } from "@/pages/api/notifications/send-push";

export type CreatePushesOptions = z.infer<typeof createPushesSchema>;

export const config = {
  maxDuration: 60, // 60 Seconds is the maximum duration allowed in Hobby Plan
};

const createPushesSchema = z.object({
  notificationId: z.cuid(),
  expiresAt: z.number(),
  subscriptionIds: z.array(z.cuid()),
});

export default createTokenProtectedApiHandler(
  createPushesSchema,
  async (options) => {
    try {
      const notification = await prisma.notification.findUnique({
        where: { id: options.notificationId },
      });

      if (
        !notification ||
        notification.canceledAt !== null ||
        notification.expiresAt < new Date()
      ) {
        return false;
      }

      const calls: Array<Promise<Response>> = [];
      options.subscriptionIds.forEach((subscriptionId) => {
        calls.push(
          callEndpoint<SendPushOptions>("/api/notifications/send-push", {
            message: notification.message,
            notificationId: notification.id,
            subscriptionId: subscriptionId,
            expiresAt: options.expiresAt,
            urgency: notification.urgency,
            tag: notification.tag || undefined,
            title: notification.title || undefined,
            imageUrl: notification.imageUrl || undefined,
          }),
        );
      });

      waitUntil(Promise.allSettled(calls));

      return true;
    } catch (e) {
      console.error("Failed to create notification", e);
      return false;
    }
  },
);
