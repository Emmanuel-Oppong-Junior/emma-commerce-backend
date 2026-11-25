-- The provider's status code from the send response (Hubtel: "0" = accepted); null when it gives none.
ALTER TABLE "Notification" ADD COLUMN     "providerStatus" TEXT;
