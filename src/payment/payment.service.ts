import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Role } from '../users/enums/role.enum';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaystackWebhookDto } from './dto/paystack.dto';
import { PaymentMethod, PaymentProvider, PaymentStatus, Prisma } from '@prisma/client';
import * as Paystack from 'paystack-api';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { PaystackEvent } from './enums/paystack-event.enum';
import { LoggerService } from '../commons/logger.service';
import { PaymentRecord, PaymentRepository } from './payment.repository';
import { NotificationsService } from '../notifications/notifications.service';
import { CHARGE_CURRENCY } from './constant';

@Injectable()
export class PaymentService {
  private readonly paystack: Paystack.Client;
  private readonly PAYSTACK_EVENTS = {
    CHARGE_SUCCESS: PaystackEvent.CHARGE_SUCCESS,
    CHARGE_FAILED: PaystackEvent.CHARGE_FAILED,
  } as const;

  constructor(
    private readonly paymentRepository: PaymentRepository,
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
    private readonly notificationsService: NotificationsService,
  ) {
    this.paystack = Paystack(this.configService.get('PAYSTACK_SECRET_KEY'));
  }

  /**
   * Initiates a payment for an order using Paystack.
   * @param userId - The ID of the user.
   * @param createPaymentDto - Payment input data.
   * @returns Payment record with Paystack authorization URL.
   */
  async initiatePayment(
    userId: string,
    createPaymentDto: CreatePaymentDto,
  ): Promise<PaymentRecord & { authorizationUrl?: string }> {
    const { orderId } = createPaymentDto;
    const order = await this.validateOrderOwnership(userId, orderId);
    if ((order as unknown as { paymentMethod: PaymentMethod }).paymentMethod === PaymentMethod.CASH_ON_DELIVERY) {
      throw new BadRequestException('This order uses cash on delivery. Online payment is not available.');
    }
    const { totalAmount } = order;
    const email = (order as unknown as { user: { email: string } }).user.email;
    await this.ensurePaymentNotCompleted(orderId);
    const totalAmountNumber = Number(totalAmount);
    const transaction = await this.initializePaystackTransaction({
      email,
      amount: totalAmountNumber,
      input: createPaymentDto,
    });
    return this.createPaymentRecord(totalAmountNumber, createPaymentDto, transaction);
  }

  /**
   * Verifies a payment status using Paystack reference.
   * For internal use by the webhook and REST callback only — no ownership check.
   * @param reference - Paystack transaction reference.
   * @returns Updated payment record.
   */
  async verifyPayment(reference: string): Promise<PaymentRecord> {
    this.logger.log(`Verifying payment | reference: ${reference}`, 'PaymentService');
    const payment = await this.fetchPaymentByReference(reference);
    const verification = await this.verifyPaystackTransaction(reference);
    return this.updatePaymentStatus(payment.id, verification);
  }

  /**
   * Verifies a payment on behalf of an authenticated user.
   * Enforces ownership — the reference must belong to an order owned by the requesting user.
   * @param reference - Paystack transaction reference.
   * @param userId - ID of the requesting user.
   * @returns Updated payment record.
   */
  async verifyPaymentAsUser(reference: string, userId: string): Promise<PaymentRecord> {
    const payment = await this.fetchPaymentByReference(reference);
    const order = await this.paymentRepository.findOrderById(payment.orderId);
    if (order?.userId !== userId) {
      throw new ForbiddenException('You do not have access to this payment');
    }
    const verification = await this.verifyPaystackTransaction(reference);
    return this.updatePaymentStatus(payment.id, verification);
  }

  /**
   * Retrieves a payment by ID.
   * Admins can access any payment; regular users can only access their own.
   * @param paymentId - The ID of the payment.
   * @param requestingUserId - The ID of the requesting user.
   * @param requestingUserRole - The role of the requesting user.
   * @returns Payment record.
   */
  async getPayment(paymentId: string, requestingUserId: string, requestingUserRole: Role): Promise<PaymentRecord> {
    const payment = await this.paymentRepository.findById(paymentId);
    if (!payment) throw new NotFoundException(`Payment "${paymentId}" not found`);
    const isAdmin = requestingUserRole === Role.ADMIN || requestingUserRole === Role.SUPER_ADMIN;
    if (!isAdmin) {
      const order = await this.paymentRepository.findOrderById(payment.orderId);
      if (order?.userId !== requestingUserId) {
        throw new UnauthorizedException('You do not have access to this payment');
      }
    }
    return payment;
  }

  async getAllPayments(): Promise<PaymentRecord[]> {
    return this.paymentRepository.findAll();
  }

  /**
   * Retrieves all payments for a user.
   * @param userId - The ID of the user.
   * @returns List of payments.
   */
  async getUserPayments(userId: string): Promise<PaymentRecord[]> {
    return this.paymentRepository.findByUser(userId);
  }

  /**
   * Records cash collection for a cash-on-delivery order (admin only).
   * Records a COMPLETED attempt with its cash collection and advances the order to DELIVERED.
   * @param orderId - The ID of the COD order.
   * @param adminId - The ID of the admin recording the collection.
   * @returns The created payment record.
   */
  async recordCodPayment(orderId: string, adminId: string): Promise<PaymentRecord> {
    const order = await this.paymentRepository.findOrderById(orderId);
    if (!order) throw new NotFoundException(`Order "${orderId}" not found`);

    if ((order as unknown as { paymentMethod: PaymentMethod }).paymentMethod !== PaymentMethod.CASH_ON_DELIVERY) {
      throw new BadRequestException(`Order "${orderId}" is not a cash-on-delivery order`);
    }

    const existing = await this.paymentRepository.findByOrderId(orderId);
    if (existing) throw new BadRequestException(`Payment for order "${orderId}" has already been recorded`);

    this.logger.log(`COD payment recorded | orderId: ${orderId} | adminId: ${adminId}`, 'PaymentService');

    const payment = await this.paymentRepository.recordCashCollection(orderId, order.totalAmount, adminId);

    await this.paymentRepository.forceUpdateOrderStatus(orderId, 'DELIVERED');

    return payment;
  }

  /**
   * Processes a Paystack webhook event.
   * @param dto - Webhook payload.
   * @param signature - Paystack signature header.
   * @returns True if processed successfully, false otherwise.
   */
  async handlePaystackWebhook(dto: PaystackWebhookDto, signature: string): Promise<boolean> {
    const { event } = dto;
    const reference = dto.data?.reference ?? 'unknown';
    const amount = dto.data?.amount ?? 0;
    const currency = dto.data?.currency ?? '';

    this.logger.log(
      `Webhook received | event: ${event} | reference: ${reference} | amount: ${amount} ${currency}`,
      'PaymentWebhook',
    );

    // [CRITICAL-1] Invalid signature must yield 401, not 200/400
    if (!this.isValidWebhookSignature(dto, signature)) {
      this.logger.warn(
        `Webhook rejected | event: ${event} | reference: ${reference} | reason: invalid signature`,
        'PaymentWebhook',
      );
      throw new UnauthorizedException('Invalid webhook signature');
    }

    if (!this.isRelevantEvent(dto.event)) {
      this.logger.log(
        `Webhook ignored | event: ${event} | reference: ${reference} | reason: unhandled event type`,
        'PaymentWebhook',
      );
      // Acknowledge receipt to Paystack without processing
      return true;
    }

    const success = await this.processWebhookPayment(reference);
    this.logger.log(
      `Webhook processed | event: ${event} | reference: ${reference} | status: ${success ? 'success' : 'failed'}`,
      'PaymentWebhook',
    );
    return success;
  }

  /**
   * Soft deletes a payment record by marking it as deleted and setting the deletion timestamp.
   * @param id - The ID of the payment to be softly deleted.
   * @returns The updated payment record with deletion status.
   * @throws NotFoundException if the payment is not found.
   */
  async softDelete(id: string) {
    await this.findPaymentOrThrow(id);
    return this.paymentRepository.update(id, { deleted: true, deletedAt: new Date() });
  }

  /**
   * Restores a soft-deleted payment record by setting its deleted status to false
   * and clearing the deletion timestamp.
   * @param id - The ID of the payment to be restored.
   * @returns The updated payment record.
   * @throws NotFoundException if the payment is not found.
   */
  async restore(id: string) {
    await this.findPaymentOrThrow(id);
    return this.paymentRepository.update(id, { deleted: false, deletedAt: null });
  }

  private async findPaymentOrThrow(id: string) {
    const payment = await this.paymentRepository.findById(id);
    if (!payment) throw new NotFoundException('Payment Not found');
  }

  private async validateOrderOwnership(userId: string, orderId: string) {
    const order = await this.paymentRepository.findOrderWithUser(orderId);
    if (!order) throw new NotFoundException(`Order "${orderId}" not found`);
    if (order.userId !== userId) throw new ForbiddenException('Order does not belong to you');
    return order;
  }

  private async ensurePaymentNotCompleted(orderId: string): Promise<void> {
    const existingPayment = await this.paymentRepository.findByOrderId(orderId);
    if (existingPayment) {
      if (existingPayment.status === PaymentStatus.COMPLETED) {
        throw new BadRequestException('Payment for this order has already been completed');
      }
      if (existingPayment.status === PaymentStatus.PENDING) {
        await this.paymentRepository.markAbandoned(existingPayment.id);
      }
    }
  }

  private async initializePaystackTransaction({
    email,
    amount,
    input,
  }: {
    email: string;
    amount: number;
    input: CreatePaymentDto;
  }): Promise<Paystack.Response<Paystack.Transaction.InitializeResponse>> {
    const { orderId } = input;
    const amountInSubunit = this.convertToSubunit(amount);
    return this.paystack.transaction.initialize({
      email,
      amount: amountInSubunit,
      currency: CHARGE_CURRENCY,
      reference: this.generateReference(orderId),
      callback_url: this.configService.get('PAYSTACK_CALLBACK_URL'),
    });
  }

  private convertToSubunit(amount: number): number {
    return Math.round(amount * 100);
  }

  private generateReference(orderId: string): string {
    return `${orderId}-${Date.now()}`;
  }

  private async createPaymentRecord(
    amount: number,
    input: CreatePaymentDto,
    transaction: Paystack.Response<Paystack.Transaction.InitializeResponse>,
  ): Promise<PaymentRecord & { authorizationUrl?: string }> {
    const { orderId, paymentMethod } = input;
    const payment = await this.paymentRepository.create({
      orderId,
      provider: PaymentProvider.PAYSTACK,
      amount,
      currency: CHARGE_CURRENCY,
      channel: paymentMethod,
      status: PaymentStatus.PENDING,
      reference: transaction.data.reference,
      providerDetails: this.sanitizeInitializeDetails(transaction.data),
    });
    return { ...payment, authorizationUrl: transaction.data.authorization_url };
  }

  /**
   * Strips raw Paystack initialization data down to the minimum fields needed for audit.
   * Never persist authorization_url or any field that could expose redirect tokens.
   * [LOW-1] Null-coalesce each field to avoid storing `undefined` in the JSON column.
   */
  private sanitizeInitializeDetails(data: Paystack.Transaction.InitializeResponse): Prisma.InputJsonValue {
    return {
      reference: data.reference ?? null,
      access_code: data.access_code ?? null,
    } as Prisma.InputJsonValue;
  }

  /**
   * Strips raw Paystack verification data down to safe audit fields.
   * Omits customer PII, IP addresses, raw channel tokens, and authorization objects.
   */
  private sanitizeVerifyDetails(data: Paystack.Transaction.VerifyResponse): Prisma.InputJsonValue {
    return {
      reference: data.reference,
      status: data.status,
      amount: data.amount,
      currency: data.currency,
      channel: data.channel,
      paid_at: data.paid_at,
      gateway_response: data.gateway_response,
    } as Prisma.InputJsonValue;
  }

  private async fetchPaymentByReference(reference: string): Promise<PaymentRecord> {
    const payment = await this.paymentRepository.findByReference(reference);
    if (!payment) throw new NotFoundException(`Payment with reference "${reference}" not found`);
    return payment;
  }

  private async verifyPaystackTransaction(
    reference: string,
  ): Promise<Paystack.Response<Paystack.Transaction.VerifyResponse>> {
    return this.paystack.transaction.verify({ reference });
  }

  private async updatePaymentStatus(
    paymentId: string,
    verification: Paystack.Response<Paystack.Transaction.VerifyResponse>,
  ): Promise<PaymentRecord> {
    const status = verification.data.status === 'success' ? PaymentStatus.COMPLETED : PaymentStatus.FAILED;
    const payment = await this.paymentRepository.updatePaymentWithStatus(
      paymentId,
      status,
      this.sanitizeVerifyDetails(verification.data),
    );

    if (status === PaymentStatus.COMPLETED) {
      const transitioned = await this.paymentRepository.updateOrderStatus(payment.orderId, 'PROCESSING');
      if (transitioned) {
        this.sendPaymentConfirmationEmail(payment.orderId, Number(payment.amount));
      } else {
        this.logger.warn(
          `Payment completed but order was not PENDING, status left unchanged | orderId: ${payment.orderId} | paymentId: ${payment.id}`,
          'PaymentService',
        );
      }
    }

    return payment;
  }

  // Sent only on the PENDING -> PROCESSING transition, so repeat webhooks and re-verifies do not email twice.
  private sendPaymentConfirmationEmail(orderId: string, amount: number): void {
    this.paymentRepository
      .findOrderWithUser(orderId)
      .then((order) => {
        if (order?.user.email) {
          this.notificationsService.sendPaymentConfirmation(order.user.email, orderId, amount);
        }
      })
      .catch((error: unknown) => {
        this.logger.error(
          `Could not send payment confirmation email | orderId: ${orderId}`,
          error instanceof Error ? error.message : String(error),
          'PaymentService',
        );
      });
  }

  private async processWebhookPayment(reference: string): Promise<boolean> {
    try {
      await this.verifyPayment(reference);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Webhook verification failed | reference: ${reference} | ${message}`, stack, 'PaymentWebhook');
      return false;
    }
  }

  private isValidWebhookSignature(dto: PaystackWebhookDto, signature: string): boolean {
    try {
      const hash = this.computeWebhookSignature(dto);
      return hash === signature;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Signature validation error | ${message}`, stack, 'PaymentService');
      return false;
    }
  }

  private computeWebhookSignature(dto: PaystackWebhookDto): string {
    const secret = this.configService.get('PAYSTACK_SECRET_KEY');
    return createHmac('sha512', secret).update(JSON.stringify(dto)).digest('hex');
  }

  private isRelevantEvent(event: PaystackEvent): boolean {
    return [this.PAYSTACK_EVENTS.CHARGE_SUCCESS, this.PAYSTACK_EVENTS.CHARGE_FAILED].includes(event);
  }
}
