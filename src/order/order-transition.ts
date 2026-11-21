import { OrderStatus, Prisma } from '../generated/prisma/client';
import { canTransition } from './order-status';

export interface TransitionContext {
  /** Who caused it; omitted for the system (payment, expiry). */
  actorId?: string;
  reason?: string;
  /** Extra conditions the order must still meet, checked in the same conditional write. */
  guard?: Prisma.OrderWhereInput;
}

/**
 * Moves an order to `to` if it is in one of `from`, not deleted and matches the guard, and writes its history event,
 * on the caller's transaction (ADR-0014). The order row is locked first, so the event records the status it really
 * left and concurrent transitions queue. Returns the status it left, or null (nothing written) when it no longer
 * qualifies. Every move must also be in the order table: a `from` the table does not allow throws.
 */
export async function transitionOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
  to: OrderStatus,
  from: readonly OrderStatus[],
  context: TransitionContext = {},
): Promise<OrderStatus | null> {
  const disallowed = from.filter((status) => !canTransition(status, to));
  if (disallowed.length > 0) throw new Error(`Order table has no ${disallowed.join('/')} -> ${to} transition`);
  const [current] = await tx.$queryRaw<{ status: OrderStatus }[]>`
    SELECT "status" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
  if (!current || !from.includes(current.status)) return null;
  const { count } = await tx.order.updateMany({
    where: { id: orderId, status: current.status, deleted: false, ...(context.guard && { AND: [context.guard] }) },
    data: { status: to },
  });
  if (count === 0) return null;
  await tx.orderStatusEvent.create({
    data: { orderId, from: current.status, to, actorId: context.actorId, reason: context.reason },
  });
  return current.status;
}
