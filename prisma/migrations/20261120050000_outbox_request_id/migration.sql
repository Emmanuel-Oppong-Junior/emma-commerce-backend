-- Correlation id of the request that recorded the event (P1-L.1). Nullable: rows written before this have none.
ALTER TABLE "OutboxEvent" ADD COLUMN "requestId" TEXT;
