import { ShipmentStatus } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * The order's latest shipment that is not cancelled; when it has none, one is written carrying every unit of the order
 * (what createShipment does by default). Before P5-B.1 the fulfilment mutations took an order id and created this
 * shipment themselves; tests written against that use this to find the shipment id they now need. It writes directly,
 * so it also works for orders createShipment refuses (unpaid, cancelled) where a test expects the step itself to fail.
 */
export async function shipmentOf(prisma: PrismaService, orderId: string): Promise<string> {
  const existing = await prisma.shipment.findFirst({
    where: { orderId, status: { not: ShipmentStatus.CANCELLED } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  if (existing) return existing.id;
  const lines = await prisma.orderItem.findMany({ where: { orderId }, select: { id: true, quantity: true } });
  const created = await prisma.shipment.create({
    data: {
      orderId,
      items: { create: lines.map((line) => ({ orderItemId: line.id, quantity: line.quantity })) },
      events: { create: { from: null, to: ShipmentStatus.PENDING } },
    },
  });
  return created.id;
}
