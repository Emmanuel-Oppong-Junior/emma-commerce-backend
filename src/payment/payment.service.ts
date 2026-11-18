import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Role } from '../users/enums/role.enum';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { OrderStatus, PaymentProvider, Prisma } from '../generated/prisma/client';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { LoggerService } from '../commons/logger.service';
import { PaymentRecord, PaymentRepository } from './payment.repository';
import { NotificationsService } from '../notifications/notifications.service';
import { assertOrderPayable, checkoutUrlForReplay } from './payment-initiation';
import { decideVerification, isSettled, parseProviderVerification } from './payment-verification';
import { assertCodCollectable } from './cash-on-delivery';
import { AuditService } from '../commons/audit.service';
import { InitializedTransaction, PaystackClient, VerifiedTransaction } from './paystack.client';
import { StoreService } from '../store/store.service';

@Injectable()
export class PaymentService {
  constructor(
    private readonly paymentRepository: PaymentRepository,
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
    private readonly notificationsService: NotificationsService,
    private readonly auditService: AuditService,
    private readonly paystack: PaystackClient,
    private readonly storeService: StoreService,
  ) {}

  /**
   * Opens a Paystack checkout for a PENDING online order. The amount and currency come from the order's payment
   * intent. Repeating an idempotency key returns the attempt already opened under it instead of a new one.
   */
  async initiatePayment(
    userId: string,
    createPaymentDto: CreatePaymentDto,
  ): Promise<PaymentRecord & { authorizationUrl: string }> {
    const { orderId, idempotencyKey } = createPaymentDto;
    await this.assertStoreCurrency(createPaymentDto.currency);
    const order = await this.paymentRepository.findOrderWithUser(orderId);
    assertOrderPayable(order, orderId, userId);

    const reference = this.generateReference(orderId);
    const opened = await this.paymentRepository.openAttempt(
      {
        orderId,
        idempotencyKey,
        reference,
        provider: PaymentProvider.PAYSTACK,
        channel: createPaymentDto.paymentMethod,
      },
      (current) => assertOrderPayable(current, orderId, userId),
    );
    if (!opened.created) {
      const authorizationUrl = checkoutUrlForReplay({
        status: opened.attempt.status,
        authorizationUrl: opened.authorizationUrl,
      });
      return { ...opened.attempt, authorizationUrl };
    }

    const authorizationUrl = await this.openPaystackCheckout(opened.attempt, reference, order.user.email);
    return { ...opened.attempt, authorizationUrl };
  }

  /**
   * Verifies a payment by its Paystack reference. For the webhook only: no ownership check.
   */
  async verifyPayment(reference: string): Promise<PaymentRecord> {
    this.logger.log(`Verifying payment | reference: ${reference}`, 'PaymentService');
    const payment = await this.fetchPaymentByReference(reference);
    return this.settleWithProvider(payment, reference);
  }

  /**
   * Verifies a payment on behalf of its owner; the reference must belong to one of the user's orders.
   */
  async verifyPaymentAsUser(reference: string, userId: string): Promise<PaymentRecord> {
    const payment = await this.fetchPaymentByReference(reference);
    const order = await this.paymentRepository.findOrderById(payment.orderId);
    if (order?.userId !== userId) {
      throw new ForbiddenException('You do not have access to this payment');
    }
    return this.settleWithProvider(payment, reference);
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
   * Records the order total as cash collected for a SHIPPED cash-on-delivery order (admin only) and moves the order
   * to DELIVERED, with an audit row, in one transaction. Any other order is refused and nothing is written.
   */
  async recordCodPayment(orderId: string, adminId: string): Promise<PaymentRecord> {
    const { attempt, collection } = await this.paymentRepository.recordCashCollection(
      orderId,
      adminId,
      (order) => assertCodCollectable(order, orderId),
      (tx, recorded) =>
        this.auditService.log(
          {
            entity: 'Order',
            entityId: orderId,
            action: 'STATUS_CHANGE',
            userId: adminId,
            details: {
              from: recorded.from,
              to: OrderStatus.DELIVERED,
              cashCollectionId: recorded.collection.id,
              paymentId: recorded.attempt.id,
              amount: recorded.collection.amount.toFixed(2),
              currency: recorded.collection.currency,
            },
          },
          tx,
        ),
    );
    this.logger.log(
      `COD payment recorded | orderId: ${orderId} | paymentId: ${attempt.id} | cashCollectionId: ${collection.id} | adminId: ${adminId}`,
      'PaymentService',
    );
    return attempt;
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

  /** The client may name the currency, but never choose it: the store currency is the only one charged. */
  private async assertStoreCurrency(requested: string | undefined): Promise<void> {
    if (requested === undefined) return;
    const currency = await this.storeService.getCurrency();
    if (requested !== currency) {
      throw new BadRequestException(`currency must be ${currency}; payments are charged in ${currency} only`);
    }
  }

  private async findPaymentOrThrow(id: string) {
    const payment = await this.paymentRepository.findById(id);
    if (!payment) throw new NotFoundException('Payment Not found');
  }

  private async openPaystackCheckout(attempt: PaymentRecord, reference: string, email: string): Promise<string> {
    try {
      const transaction = await this.paystack.initializeTransaction({
        email,
        amount: attempt.amount.mul(100).toNumber(),
        currency: attempt.currency,
        reference,
        callback_url: this.configService.get('PAYSTACK_CALLBACK_URL'),
      });
      const authorizationUrl = transaction.authorization_url;
      await this.paymentRepository.recordCheckout(
        attempt.id,
        authorizationUrl,
        this.sanitizeInitializeDetails(transaction),
      );
      return authorizationUrl;
    } catch (error) {
      this.logger.error(
        `Paystack checkout could not be opened | orderId: ${attempt.orderId} | paymentId: ${attempt.id}`,
        error instanceof Error ? error.message : String(error),
        'PaymentService',
      );
      await this.paymentRepository.markInitializationFailed(attempt.id);
      throw error;
    }
  }

  // The random suffix keeps two initiations in the same millisecond from colliding on the unique reference.
  private generateReference(orderId: string): string {
    return `${orderId}-${Date.now()}-${randomBytes(4).toString('hex')}`;
  }

  /**
   * Strips raw Paystack initialization data down to the minimum fields needed for audit.
   * The checkout URL is kept in its own column so an idempotent retry can hand it back.
   * [LOW-1] Null-coalesce each field to avoid storing `undefined` in the JSON column.
   */
  private sanitizeInitializeDetails(data: InitializedTransaction): Prisma.InputJsonValue {
    return {
      reference: data.reference ?? null,
      access_code: data.access_code ?? null,
    } as Prisma.InputJsonValue;
  }

  /**
   * Strips raw Paystack verification data down to safe audit fields.
   * Omits customer PII, IP addresses, raw channel tokens, and authorization objects.
   */
  private sanitizeVerifyDetails(data: VerifiedTransaction): Prisma.InputJsonValue {
    return {
      reference: data.reference ?? null,
      status: data.status ?? null,
      amount: data.amount ?? null,
      currency: data.currency ?? null,
      channel: data.channel ?? null,
      paid_at: data.paid_at ?? null,
      gateway_response: data.gateway_response ?? null,
    } as Prisma.InputJsonValue;
  }

  private async fetchPaymentByReference(reference: string): Promise<PaymentRecord> {
    const payment = await this.paymentRepository.findByReference(reference);
    if (!payment) throw new NotFoundException(`Payment with reference "${reference}" not found`);
    return payment;
  }

  /**
   * The one path from a provider verdict to the ledger and the order, shared by the customer verify and the
   * webhook. A settled attempt is returned as it is, so replays and late events change nothing.
   */
  private async settleWithProvider(payment: PaymentRecord, reference: string): Promise<PaymentRecord> {
    if (isSettled(payment.status)) return payment;
    const transaction = await this.paystack.verifyTransaction(reference);
    const verified = parseProviderVerification(reference, transaction);
    const settled = await this.paymentRepository.settleAttempt(
      payment.id,
      verified,
      this.sanitizeVerifyDetails(transaction),
      (state) => decideVerification(state, verified),
    );

    const { outcome, attempt } = settled;
    if (outcome.kind === 'paid') {
      this.sendPaymentConfirmationEmail(attempt.orderId, Number(attempt.amount));
    } else if (outcome.kind === 'review') {
      this.logger.warn(
        `Payment needs review, order left unchanged and refund queued | reason: ${outcome.reason} | orderId: ${attempt.orderId} | paymentId: ${attempt.id} | refundId: ${settled.refundId} | provider amount: ${verified.amount} ${verified.currency}`,
        'PaymentService',
      );
    }
    return attempt;
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
}
