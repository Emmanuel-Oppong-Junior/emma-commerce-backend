-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "body" TEXT,
ADD COLUMN     "readAt" TIMESTAMP(3),
ADD COLUMN     "refId" TEXT,
ADD COLUMN     "refType" TEXT,
ADD COLUMN     "title" TEXT;

-- CreateIndex
CREATE INDEX "Notification_userId_channel_createdAt_id_idx" ON "Notification"("userId", "channel", "createdAt" DESC, "id" DESC);

-- A sent in-app notification has the text the feed shows; only in-app notifications are read.
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_in_app_text"
  CHECK ("channel" <> 'IN_APP' OR "status" <> 'SENT' OR ("title" IS NOT NULL AND "body" IS NOT NULL));
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_read_in_app"
  CHECK ("readAt" IS NULL OR "channel" = 'IN_APP');
