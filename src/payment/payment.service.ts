import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { OrderStatus, PaymentProvider, Prisma } from '../generated/prisma/client';
import { OnlinePaymentMethod } from './settings/payment-methods';
import { PaymentSettingsService } from './settings/payment-settings.service';
import { randomBytes } from 'node:crypto';
import { LoggerService } from '../commons/logger.service';
import { PaymentRecord, PaymentRepository } from './payment.repository';
import { assertOrderPayable, checkoutUrlForReplay } from './payment-initiation';
import { decideVerification, isSettled, ProviderVerification } from './payment-verification';
import { assertCodCollectable, collectableShipment } from './cash-on-delivery';
import { assertCollectedAmount, assertCollectedAt, assertCollector } from './cash/cash-collection';
import { proofRequired } from '../delivery/proof/proof-of-delivery';
import { AuditService } from '../commons/audit.service';
import { StoreService } from '../store/store.service';
import { PaymentProviderRegistry } from './providers/payment-provider.registry';
import { VelocityService } from '../fraud/velocity.service';
import { VelocityCheckpoint, VelocityEvent, velocitySubjects } from '../fraud/velocity-rules';

export interface RecordCodPaymentParams {
  orderId: string;
  riderId: string;
  amount: Prisma.Decimal;
  collectedAt?: Date;
}

@Injectable()
export class PaymentService {
  constructor(
    private readonly paymentRepository: PaymentRepository,
    private readonly logger: LoggerService,
    private readonly auditService: AuditService,
    private readonly providers: PaymentProviderRegistry,
    private readonly storeService: StoreService,
    private readonly paymentSettings: PaymentSettingsService,
    private readonly velocity: VelocityService,
  ) {}

  /**
   * Opens a checkout for a PENDING online order with the provider the store configured for the chosen method (card
   * or mobile money); BAD_REQUEST with reason PAYMENT_METHOD_UNAVAILABLE when the store does not offer it. The amount
   * and currency come from the order's payment intent. Repeating an idempotency key returns the attempt already
   * opened under it instead of a new one. FORBIDDEN with reason VELOCITY_LIMIT when the account or network started
   * or failed too many payments in a short time.
   */
  async initiatePayment(
    userId: string,
    createPaymentDto: CreatePaymentDto,
    clientIp?: string,
  ): Promise<PaymentRecord & { authorizationUrl: string }> {
    const order = await this.paymentRepository.findOrderWithUser(createPaymentDto.orderId);
    return this.openPayment(order, userId, createPaymentDto, velocitySubjects({ customerId: userId, ip: clientIp }));
  }

  /**
   * initiatePayment for a guest order (P6-G.1), named by its access token: screened per verified phone and network,
   * and sent to the provider with the order's contact email, else `payerEmailFallback` (the provider needs one).
   */
  async initiateGuestPayment(
    orderId: string,
    createPaymentDto: Omit<CreatePaymentDto, 'orderId'>,
    payerEmailFallback: string,
    clientIp?: string,
  ): Promise<PaymentRecord & { authorizationUrl: string }> {
    const order = await this.paymentRepository.findOrderWithUser(orderId);
    const subjects = velocitySubjects({ phone: order?.guestPhone ?? undefined, ip: clientIp });
    return this.openPayment(order, null, { ...createPaymentDto, orderId }, subjects, payerEmailFallback);
  }

  /** A guest's verify (P6-G.1): the reference must be one of the order its access token named. */
  async verifyGuestPayment(reference: string, orderId: string): Promise<PaymentRecord> {
    const payment = await this.fetchPaymentByReference(reference);
    if (payment.orderId !== orderId) throw new ForbiddenException('You do not have access to this payment');
    return this.settleWithProvider(payment, reference);
  }

  private async openPayment(
    order: Awaited<ReturnType<PaymentRepository['findOrderWithUser']>>,
    userId: string | null,
    createPaymentDto: CreatePaymentDto,
    subjects: ReturnType<typeof velocitySubjects>,
    payerEmailFallback?: string,
  ): Promise<PaymentRecord & { authorizationUrl: string }> {
    const { orderId, idempotencyKey, paymentMethod } = createPaymentDto;
    await this.assertStoreCurrency(createPaymentDto.currency);
    assertOrderPayable(order, orderId, userId);
    const provider = await this.paymentSettings.onlineProviderFor(paymentMethod);
    const softHits = await this.velocity.screenOrRefuse(VelocityCheckpoint.PAYMENT_INITIATION, subjects);

    const reference = this.generateReference(orderId);
    const opened = await this.paymentRepository.openAttempt(
      {
        orderId,
        idempotencyKey,
        reference,
        provider,
        channel: paymentMethod,
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
    await this.velocity.flagOrder(orderId, softHits);
    await this.velocity.record(VelocityEvent.PAYMENT_STARTED, subjects);

    const email = order.user?.email ?? order.contactEmail ?? payerEmailFallback;
    if (!email) throw new Error(`Order "${orderId}" has no email to open a checkout with`);
    const authorizationUrl = await this.openCheckout(provider, paymentMethod, opened.attempt, reference, email);
    return { ...opened.attempt, authorizationUrl };
  }

  /**
   * Verifies a payment by its provider reference. For the webhook only: no ownership check.
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
   * Staff with payment.view can access any payment; everyone else only their own.
   * @param paymentId - The ID of the payment.
   * @param requestingUserId - The ID of the requesting user.
   * @param canViewAnyPayment - Whether the requester holds payment.view.
   * @returns Payment record.
   */
  async getPayment(paymentId: string, requestingUserId: string, canViewAnyPayment: boolean): Promise<PaymentRecord> {
    const payment = await this.paymentRepository.findById(paymentId);
    if (!payment) throw new NotFoundException(`Payment "${paymentId}" not found`);
    if (!canViewAnyPayment) {
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
   * Records the grand total as cash collected for a dispatched cash-on-delivery order (staff, payment.record): the
   * payment is captured, the shipment DELIVERED and the order COMPLETED, with the collection (rider, time) and an audit
   * row, in one transaction. The rider must be an active staff member and the amount must equal the grand total
   * (BAD_REQUEST otherwise); any other order is refused. A shipment with a rider is delivered with its proof instead
   * (BAD_REQUEST PROOF_OF_DELIVERY_REQUIRED; completeDelivery records the cash). Nothing is written when anything is
   * refused.
   */
  async recordCodPayment(input: RecordCodPaymentParams, adminId: string): Promise<PaymentRecord> {
    const { attempt } = await this.collectCash(input, adminId);
    return attempt;
  }

  /**
   * The cash of a rider's cash-on-delivery delivery (P5-C.2), on the caller's transaction (the order locked, the proof
   * of delivery just written): recordCodPayment's rules and writes, for the shipment's rider. Returns the collection id.
   */
  async recordDeliveredCash(
    tx: Prisma.TransactionClient,
    input: Required<RecordCodPaymentParams>,
    actorId: string,
  ): Promise<string> {
    const { collection } = await this.collectCash(input, actorId, tx);
    return collection.id;
  }

  private async collectCash(input: RecordCodPaymentParams, adminId: string, proofTx?: Prisma.TransactionClient) {
    const { orderId, riderId, amount } = input;
    const now = new Date();
    const collectedAt = input.collectedAt ?? now;
    const recorded = await this.paymentRepository.recordCashCollection(
      orderId,
      { recordedById: adminId, riderId, collectedAt },
      (order, rider) => {
        assertCodCollectable(order, orderId);
        const shipment = collectableShipment(order);
        if (shipment.riderId && !proofTx) throw proofRequired(shipment.id);
        assertCollector(rider, riderId, order.fulfillmentType);
        assertCollectedAmount(order.grandTotal, amount);
        assertCollectedAt(collectedAt, now, shipment.dispatchedAt);
      },
      (tx, recorded) =>
        this.auditService.log(
          {
            entity: 'Order',
            entityId: orderId,
            action: 'STATUS_CHANGE',
            userId: adminId,
            details: {
              from: recorded.from,
              to: OrderStatus.COMPLETED,
              cashCollectionId: recorded.collection.id,
              paymentId: recorded.attempt.id,
              amount: recorded.collection.amount.toFixed(2),
              currency: recorded.collection.currency,
              riderId,
              collectedAt: recorded.collection.collectedAt.toISOString(),
            },
          },
          tx,
        ),
      ...(proofTx ? [proofTx] : []),
    );
    this.logger.log(
      `COD payment recorded | orderId: ${orderId} | paymentId: ${recorded.attempt.id} | cashCollectionId: ${recorded.collection.id} | riderId: ${riderId} | adminId: ${adminId}`,
      'PaymentService',
    );
    return recorded;
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

  private async openCheckout(
    providerName: PaymentProvider,
    method: OnlinePaymentMethod,
    attempt: PaymentRecord,
    reference: string,
    email: string,
  ): Promise<string> {
    const provider = this.providers.get(providerName);
    try {
      const { authorizationUrl, details } = await provider.initialize({
        method,
        email,
        amount: attempt.amount,
        currency: attempt.currency,
        reference,
      });
      await this.paymentRepository.recordCheckout(attempt.id, authorizationUrl, details);
      return authorizationUrl;
    } catch (error) {
      this.logger.error(
        `${provider.label} checkout could not be opened | orderId: ${attempt.orderId} | paymentId: ${attempt.id}`,
        error instanceof Error ? error.message : String(error),
        'PaymentService',
      );
      await this.paymentRepository.markInitializationFailed(attempt.id);
      throw error;
    }
  }

  /**
   * Counts a failed payment against the customer and the card, then flags the order when the customer's or the card's
   * failures are above a limit. Settlement is never refused: the money has already moved (or not) at the provider.
   */
  private async checkSettlementVelocity(
    attempt: PaymentRecord,
    failed: boolean,
    verified: ProviderVerification,
  ): Promise<void> {
    if (!failed && !verified.cardFingerprint) return;
    const subjects = velocitySubjects({
      customerId: attempt.order?.userId ?? undefined,
      card: verified.cardFingerprint,
    });
    if (failed) await this.velocity.record(VelocityEvent.PAYMENT_FAILED, subjects);
    const hits = await this.velocity.screen(VelocityCheckpoint.PAYMENT_SETTLEMENT, subjects);
    await this.velocity.flagOrder(attempt.orderId, hits);
  }

  // The random suffix keeps two initiations in the same millisecond from colliding on the unique reference.
  private generateReference(orderId: string): string {
    return `${orderId}-${Date.now()}-${randomBytes(4).toString('hex')}`;
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
    const { verification: verified, details } = await this.providers.get(payment.provider).verify(reference);
    const settled = await this.paymentRepository.settleAttempt(payment.id, verified, details, (state) =>
      decideVerification(state, verified),
    );

    const { outcome, attempt } = settled;
    await this.checkSettlementVelocity(attempt, outcome.kind === 'failed', verified);
    if (outcome.kind === 'review') {
      this.logger.warn(
        `Payment needs review, order left unchanged and refund queued | reason: ${outcome.reason} | orderId: ${attempt.orderId} | paymentId: ${attempt.id} | refundId: ${settled.refundId} | provider amount: ${verified.amount} ${verified.currency}`,
        'PaymentService',
      );
    }
    return attempt;
  }
}
