import { Prisma, ReturnStatus } from '../generated/prisma/client';
import { canReturnTransition } from './return-status';

export interface ReturnTransitionContext {
  actorId?: string | null;
  /** Staff note or reason, kept on the history event (never shown to the customer). */
  note?: string | null;
  /** Other columns written with the status, in the same conditional update. */
  data?: Omit<Prisma.ReturnRequestUncheckedUpdateManyInput, 'status'>;
}

/**
 * Moves a return request to `to` if it is in one of `from`, and writes its history event, on the caller's transaction.
 * The request row is locked first, so the event records the status it really left and concurrent moves queue. Returns
 * the status it left, or null (nothing written) when it no longer qualifies. A `from` the table does not allow throws.
 */
export async function transitionReturn(
  tx: Prisma.TransactionClient,
  returnRequestId: string,
  to: ReturnStatus,
  from: readonly ReturnStatus[],
  context: ReturnTransitionContext = {},
): Promise<ReturnStatus | null> {
  const disallowed = from.filter((status) => !canReturnTransition(status, to));
  if (disallowed.length > 0) throw new Error(`Return table has no ${disallowed.join('/')} -> ${to} transition`);
  const [current] = await tx.$queryRaw<{ status: ReturnStatus }[]>`
    SELECT "status" FROM "ReturnRequest" WHERE "id" = ${returnRequestId} FOR UPDATE`;
  if (!current || !from.includes(current.status)) return null;
  const { count } = await tx.returnRequest.updateMany({
    where: { id: returnRequestId, status: current.status },
    data: { ...context.data, status: to },
  });
  if (count === 0) return null;
  await tx.returnStatusEvent.create({
    data: {
      returnRequestId,
      from: current.status,
      to,
      actorId: context.actorId ?? null,
      note: context.note ?? null,
    },
  });
  return current.status;
}
