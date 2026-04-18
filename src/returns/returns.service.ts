import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReturnRequest } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReturnsRepository } from './returns.repository';
import { CreateReturnRequestInput } from './dto/create-return-request.input';
import { ApproveReturnInput, RejectReturnInput } from './dto/review-return.input';
import { LoggerService } from '../commons/logger.service';
import axios from 'axios';

@Injectable()
export class ReturnsService {
  constructor(
    private readonly returnsRepository: ReturnsRepository,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
  ) {}

  /**
   * Submits a return request for a delivered order owned by the user.
   * @param userId - The ID of the user making the request.
   * @param input - Return request data including the order ID and reason.
   * @returns The created return request.
   * @throws NotFoundException if the order is not found or does not belong to the user.
   * @throws BadRequestException if the order is not delivered or an active return request already exists.
   */
  async createReturnRequest(userId: string, input: CreateReturnRequestInput): Promise<ReturnRequest> {
    const order = await this.prisma.order.findUnique({
      where: { id: input.orderId },
      include: { payment: true },
    });
    if (order?.userId !== userId) {
      throw new NotFoundException(`Order "${input.orderId}" not found`);
    }
    if (order.status !== 'DELIVERED') {
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
   * @param input - Approval data including the return request ID, refund amount, and optional admin note.
   * @returns The updated return request with APPROVED status.
   * @throws NotFoundException if the return request does not exist.
   * @throws BadRequestException if the request is not in PENDING status.
   */
  async approveReturn(input: ApproveReturnInput): Promise<ReturnRequest> {
    const returnRequest = await this.findReturnOrThrow(input.returnRequestId);
    if (returnRequest.status !== 'PENDING') {
      throw new BadRequestException(`Return request is already ${returnRequest.status}`);
    }
    return this.returnsRepository.updateStatus(input.returnRequestId, 'APPROVED', input.refundAmount, input.adminNote);
  }

  /**
   * Rejects a pending return request with an admin note (admin only).
   * @param input - Rejection data including the return request ID and an admin note.
   * @returns The updated return request with REJECTED status.
   * @throws NotFoundException if the return request does not exist.
   * @throws BadRequestException if the request is not in PENDING status.
   */
  async rejectReturn(input: RejectReturnInput): Promise<ReturnRequest> {
    const returnRequest = await this.findReturnOrThrow(input.returnRequestId);
    if (returnRequest.status !== 'PENDING') {
      throw new BadRequestException(`Return request is already ${returnRequest.status}`);
    }
    return this.returnsRepository.updateStatus(input.returnRequestId, 'REJECTED', undefined, input.adminNote);
  }

  /**
   * Initiates a Paystack refund for an approved return request and restores the product stock.
   * @param returnRequestId - The ID of the approved return request to refund.
   * @returns The updated return request with REFUNDED status.
   * @throws NotFoundException if the return request or associated payment is not found.
   * @throws BadRequestException if the request is not approved, refund amount is missing, or the Paystack call fails.
   */
  async processRefund(returnRequestId: string): Promise<ReturnRequest> {
    const returnRequest = await this.findReturnOrThrow(returnRequestId);
    if (returnRequest.status !== 'APPROVED') {
      throw new BadRequestException('Only approved return requests can be refunded');
    }
    if (!returnRequest.refundAmount) {
      throw new BadRequestException('Refund amount not set');
    }

    const payment = await this.prisma.payment.findUnique({
      where: { orderId: returnRequest.orderId },
    });
    if (!payment?.transactionId) {
      throw new BadRequestException('No payment transaction found for this order');
    }

    await this.callPaystackRefund(payment.transactionId, Number(returnRequest.refundAmount));

    return this.prisma.$transaction(async (tx) => {
      await this.returnsRepository.restoreOrderStock(tx, returnRequest.orderId);
      return this.returnsRepository.updateStatus(returnRequestId, 'REFUNDED');
    });
  }

  /**
   * Retrieves all return requests submitted by a specific user.
   * @param userId - The ID of the user.
   * @returns List of return requests for the user.
   */
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

  private async callPaystackRefund(transactionReference: string, amount: number): Promise<void> {
    const secretKey = this.configService.get<string>('PAYSTACK_SECRET_KEY');
    const amountInKobo = Math.round(amount * 100);
    try {
      await axios.post(
        'https://api.paystack.co/refund',
        { transaction: transactionReference, amount: amountInKobo },
        { headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' } },
      );
      this.logger.log(
        `Paystack refund initiated | reference: ${transactionReference} | amount: ${amount}`,
        'ReturnsService',
      );
    } catch (error) {
      this.logger.error(
        `Paystack refund failed | reference: ${transactionReference}`,
        error instanceof Error ? error.message : String(error),
        'ReturnsService',
      );
      throw new BadRequestException('Refund processing failed. Please try again.');
    }
  }

  private async findReturnOrThrow(id: string): Promise<ReturnRequest> {
    const returnRequest = await this.returnsRepository.findById(id);
    if (!returnRequest) throw new NotFoundException(`Return request "${id}" not found`);
    return returnRequest;
  }
}
