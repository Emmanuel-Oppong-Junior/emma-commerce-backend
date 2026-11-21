import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { OrderStatus, PaymentStatus, Prisma, ReturnRequest, ReturnStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReturnsRepository } from './returns.repository';
import { CreateReturnRequestInput } from './dto/create-return-request.input';
import { ApproveReturnInput, RejectReturnInput } from './dto/review-return.input';
import { AuditService } from '../commons/audit.service';
import { RefundsService } from './refunds.service';
import { RefundRepository } from './refund.repository';

@Injectable()
export class ReturnsService {
  constructor(
    private readonly returnsRepository: ReturnsRepository,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly refundsService: RefundsService,
    private readonly refundRepository: RefundRepository,
  ) {}

  /**
   * Submits a return request for a completed (delivered or collected) order owned by the user.
   * @param userId - The ID of the user making the request.
   * @param input - Return request data including the order ID and reason.
   * @returns The created return request.
   * @throws NotFoundException if the order is not found or does not belong to the user.
   * @throws BadRequestException if the order is not delivered or an active return request already exists.
   */
  async createReturnRequest(userId: string, input: CreateReturnRequestInput): Promise<ReturnRequest> {
    const order = await this.prisma.order.findUnique({ where: { id: input.orderId } });
    if (order?.userId !== userId) {
      throw new NotFoundException(`Order "${input.orderId}" not found`);
    }
    if (order.status !== OrderStatus.COMPLETED) {
      throw new BadRequestException('Return requests can only be made for delivered orders');
    }
    const existing = await this.returnsRepository.findByOrder(input.orderId);
    const active = existing.find((r) => r.status !== 'REJECTED');
    if (active) {
      throw new BadRequestException('A return request for this order already exists');
    }
    return this.returnsRepository.create({
      orderId: input.orderId,
      userId,
      reason: input.reason,
    });
  }

  /**
   * Approves a pending return request and sets the refund amount (admin only).
   * @throws NotFoundException if the return request does not exist.
   * @throws BadRequestException if the request is not in PENDING status.
   * @throws ConflictException if another request changed it first.
   */
  async approveReturn(input: ApproveReturnInput, adminUserId: string): Promise<ReturnRequest> {
    return this.reviewPending(input.returnRequestId, ReturnStatus.APPROVED, adminUserId, {
      refundAmount: input.refundAmount,
      adminNote: input.adminNote,
    });
  }

  /**
   * Rejects a pending return request with an admin note (admin only).
   * @throws NotFoundException if the return request does not exist.
   * @throws BadRequestException if the request is not in PENDING status.
   * @throws ConflictException if another request changed it first.
   */
  async rejectReturn(input: RejectReturnInput, adminUserId: string): Promise<ReturnRequest> {
    return this.reviewPending(input.returnRequestId, ReturnStatus.REJECTED, adminUserId, {
      adminNote: input.adminNote,
    });
  }

  /**
   * Refunds an approved return request through Paystack. Moves money only: stock is never restored here
   * (cancellation already restored it, and returned goods are restocked by an admin via `restockVariant` once
   * received and inspected).
   *
   * An APPROVED request is claimed (-> REFUND_PENDING) together with its PENDING refund before Paystack is called; a
   * REFUND_PENDING request resends its refund if that refund was never sent or was refused. Concurrent or repeated
   * calls get CONFLICT, so Paystack is called at most once per claim.
   * @throws NotFoundException if the return request does not exist.
   * @throws BadRequestException if it cannot be refunded, the amount is above what is still refundable, or Paystack refuses.
   * @throws ConflictException if another request is refunding it or it was already refunded.
   */
  async processRefund(returnRequestId: string, adminUserId: string): Promise<ReturnRequest> {
    const returnRequest = await this.findReturnOrThrow(returnRequestId);
    const refundId =
      returnRequest.status === ReturnStatus.REFUND_PENDING
        ? await this.existingRefundId(returnRequest)
        : await this.openRefund(returnRequest, adminUserId);

    const { returnRequest: refunded } = await this.refundsService.send(refundId, adminUserId);
    return refunded ?? this.findReturnOrThrow(returnRequestId);
  }

  /**
   * Retrieves all return requests submitted by a specific user.
   * @param userId - The ID of the user.
   * @returns List of return requests for the user.
   */
  async createSystemReturnRequest(orderId: string, userId: string, reason: string): Promise<void> {
    const existing = await this.returnsRepository.findByOrder(orderId);
    if (existing.some((r) => r.status !== 'REJECTED')) return;
    await this.returnsRepository.create({ orderId, userId, reason });
  }

  async findByUser(userId: string): Promise<ReturnRequest[]> {
    return this.returnsRepository.findByUser(userId);
  }

  /**
   * Retrieves all return requests in the system (admin only).
   * @returns List of all return requests.
   */
  async findAll(): Promise<ReturnRequest[]> {
    return this.returnsRepository.findAll();
  }

  private async openRefund(returnRequest: ReturnRequest, adminUserId: string): Promise<string> {
    if (returnRequest.status !== ReturnStatus.APPROVED) {
      throw new BadRequestException('Only approved return requests can be refunded');
    }
    const { refundAmount } = returnRequest;
    if (!refundAmount || refundAmount.lte(0)) {
      throw new BadRequestException('Refund amount not set');
    }
    // The attempt that paid the order comes first; a late duplicate charge flagged for review is refunded on its own.
    const payment = await this.prisma.paymentAttempt.findFirst({
      where: { intent: { orderId: returnRequest.orderId }, status: PaymentStatus.CAPTURED, reference: { not: null } },
      orderBy: [{ reviewReason: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
    });
    if (!payment?.reference) {
      throw new BadRequestException('No payment transaction found for this order');
    }
    const refund = await this.refundsService.openForReturn({ ...returnRequest, refundAmount }, payment.id, adminUserId);
    return refund.id;
  }

  private async existingRefundId(returnRequest: ReturnRequest): Promise<string> {
    const refund = await this.refundRepository.findByReturnRequest(returnRequest.id);
    if (!refund) {
      throw new ConflictException(`Return request "${returnRequest.id}" is REFUND_PENDING but has no refund`);
    }
    return refund.id;
  }

  private async reviewPending(
    id: string,
    to: ReturnStatus,
    adminUserId: string,
    changes: { refundAmount?: Prisma.Decimal; adminNote?: string },
  ): Promise<ReturnRequest> {
    const returnRequest = await this.findReturnOrThrow(id);
    if (returnRequest.status !== ReturnStatus.PENDING) {
      throw new BadRequestException(`Return request is already ${returnRequest.status}`);
    }
    return this.changeStatusAudited(returnRequest, to, adminUserId, async (tx) => {
      const updated = await this.returnsRepository.transitionStatus(id, ReturnStatus.PENDING, to, changes, tx);
      if (!updated) throw new ConflictException(`Return request "${id}" was reviewed by another request`);
      return updated;
    });
  }

  private changeStatusAudited(
    before: ReturnRequest,
    to: ReturnStatus,
    adminUserId: string,
    change: (tx: Prisma.TransactionClient) => Promise<ReturnRequest>,
  ): Promise<ReturnRequest> {
    return this.auditService.record(change, (after) => ({
      entity: 'ReturnRequest',
      entityId: before.id,
      action: 'STATUS_CHANGE',
      userId: adminUserId,
      details: {
        orderId: before.orderId,
        from: before.status,
        to,
        refundAmount: after.refundAmount === null ? null : String(after.refundAmount),
      },
    }));
  }

  private async findReturnOrThrow(id: string): Promise<ReturnRequest> {
    const returnRequest = await this.returnsRepository.findById(id);
    if (!returnRequest) throw new NotFoundException(`Return request "${id}" not found`);
    return returnRequest;
  }
}
