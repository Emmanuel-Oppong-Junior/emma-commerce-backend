import { Injectable } from '@nestjs/common';
import { Prisma, ProofOfDelivery, ProofOfDeliveryMethod } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

type Tx = Prisma.TransactionClient;

export interface NewProofOfDelivery {
  shipmentId: string;
  method: ProofOfDeliveryMethod;
  overrideReason: string | null;
  deliveredById: string;
  deliveredAt: Date;
  photoUrl: string | null;
  photoPublicId: string | null;
  recipientName: string | null;
  latitude: Prisma.Decimal | null;
  longitude: Prisma.Decimal | null;
}

/** Data access for proofs of delivery (P5-C.2). */
@Injectable()
export class ProofOfDeliveryRepository {
  constructor(private readonly prisma: PrismaService) {}

  runTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  /** What deciding a delivery needs, read without a lock (re-checked under the order lock). */
  async findShipmentForProof(shipmentId: string) {
    return this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      select: {
        id: true,
        status: true,
        riderId: true,
        dispatchedAt: true,
        order: { select: { id: true, paymentMethod: true } },
      },
    });
  }

  async create(tx: Tx, proof: NewProofOfDelivery): Promise<ProofOfDelivery> {
    return tx.proofOfDelivery.create({ data: proof });
  }

  async findByShipmentIds(shipmentIds: readonly string[]): Promise<ProofOfDelivery[]> {
    return this.prisma.proofOfDelivery.findMany({ where: { shipmentId: { in: [...shipmentIds] } } });
  }
}
