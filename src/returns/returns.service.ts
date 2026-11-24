import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  OrderStatus,
  PaymentStatus,
  Prisma,
  Refund,
  ReturnRequest,
  ReturnResolution,
  ReturnStatus,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../commons/audit.service';
import { CloudinaryService } from '../commons/cloudinary.service';
import { OutboxService } from '../outbox/outbox.service';
import { InventoryService } from '../inventory/inventory.service';
import { StockLedgerService } from '../inventory/stock-ledger.service';
import { StockLedgerRepository } from '../inventory/stock-ledger.repository';
import { StockLocationsService } from '../inventory/locations/stock-locations.service';
import { OrdersRepository } from '../order/order.repository';
import { transitionOrder } from '../order/order-transition';
import { PRICING_VERSION } from '../pricing/price';
import { notSellableReason } from '../variant/sellable';
import { RefundsService } from './refunds.service';
import { RefundRepository } from './refund.repository';
import { ReturnFilter, ReturnsRepository, ReturnWithLines } from './returns.repository';
import { transitionReturn } from './return-transition';
import { assertReturnTransition, CUSTOMER_CANCELLABLE_RETURN, REJECTABLE_RETURN } from './return-status';
import {
  checkReturnLines,
  CheckedReturnLine,
  EXCHANGE_NOT_ALLOWED,
  EXCHANGE_OUT_OF_STOCK,
  exchangeRefusal,
  inspectionProblem,
  receiptProblem,
  replacementLines,
  RequestedReturnLine,
  returnLineRefusal,
} from './return-rules';
import { CustomerReturn, ReturnLine, ReturnRequestEntity, StaffReturnLine } from './entities/return.entities';

type Tx = Prisma.TransactionClient;

const MAX_PAGE_SIZE = 100;

export interface ReturnRequestParams {
  orderId: string;
  resolution: ReturnResolution;
  lines: RequestedReturnLine[];
}

export interface Page<T> {
  nodes: T[];
  totalCount: number;
  hasNextPage: boolean;
}

/** Statuses the customer is told about by return.status_changed.v1 (a refund is told by refund.succeeded.v1). */
type NotifiedStatus =
  | typeof ReturnStatus.APPROVED
  | typeof ReturnStatus.REJECTED
  | typeof ReturnStatus.RECEIVED
  | typeof ReturnStatus.EXCHANGED;

/**
 * Item-level returns (P6-R.1): a customer returns some delivered units of an order's lines within the window of
 * their product type; staff approve or reject, receive the goods (per line quantity), inspect them (restock or write
 * off each unit) and settle with a refund priced from the order's snapshot or an exchange for another variant of the
 * same product. Every move is a conditional transition with its history event; staff moves are audited and the
 * customer-facing ones record return.status_changed.v1.
 */
@Injectable()
export class ReturnsService {
  constructor(
    private readonly repository: ReturnsRepository,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly cloudinary: CloudinaryService,
    private readonly outbox: OutboxService,
    private readonly refundsService: RefundsService,
    private readonly refundRepository: RefundRepository,
    private readonly inventory: InventoryService,
    private readonly ledger: StockLedgerService,
    private readonly ledgerRepository: StockLedgerRepository,
    private readonly stockLocations: StockLocationsService,
    private readonly ordersRepository: OrdersRepository,
  ) {}

  /**
   * A customer returns units of their own order: each line's units must have been delivered within the window of its
   * product type (default the store's 14 days, from the delivery of the shipment that carried them), the type must be
   * returnable, and the units not already refunded or under another return. Checked and written under the order row
   * lock, so concurrent requests cannot exceed the units delivered.
   * @throws NotFoundException for another customer's or an unknown order; BadRequestException (with `reason`) for a
   *   non-returnable product, units outside the window, never delivered, or a bad request; ConflictException
   *   (RETURN_QUANTITY_EXCEEDED) for more units than are left.
   */
  async requestReturn(userId: string, params: ReturnRequestParams): Promise<CustomerReturn> {
    const created = await this.prisma.$transaction(async (tx) => {
      const order = await this.repository.lockOrder(tx, params.orderId);
      if (!order || order.deleted || order.userId !== userId) {
        throw new NotFoundException(`Order "${params.orderId}" not found`);
      }
      const lines = await this.checkRequest(tx, params, false);
      return this.repository.create(tx, {
        orderId: order.id,
        userId,
        resolution: params.resolution,
        lines,
        actorId: userId,
      });
    });
    return this.customerView(created);
  }

  /**
   * Staff accept a return the policy refuses (outside the window, or a non-returnable product type) with a reason: it
   * is created for the order's customer as APPROVED and audited. The units must still have been delivered and not be
   * refunded or under another return.
   */
  async acceptReturnOutsidePolicy(
    params: ReturnRequestParams & { overrideReason: string; staffNote?: string },
    actorId: string,
  ): Promise<ReturnRequestEntity> {
    const created = await this.auditService.record(
      async (tx) => {
        const order = await this.repository.lockOrder(tx, params.orderId);
        if (!order || order.deleted) throw new NotFoundException(`Order "${params.orderId}" not found`);
        const lines = await this.checkRequest(tx, params, true);
        const request = await this.repository.create(tx, {
          orderId: order.id,
          userId: order.userId,
          resolution: params.resolution,
          lines,
          actorId,
          createdById: actorId,
          policyOverrideReason: params.overrideReason,
          staffNote: params.staffNote?.trim() || null,
          approved: true,
        });
        await this.notify(tx, request, ReturnStatus.APPROVED);
        return request;
      },
      (request) => ({
        entity: 'ReturnRequest',
        entityId: request.id,
        action: 'CREATE',
        userId: actorId,
        details: {
          orderId: request.orderId,
          status: request.status,
          resolution: request.resolution,
          policyOverrideReason: params.overrideReason,
          lines: request.lines.map((line) => ({ orderItemId: line.orderItemId, quantity: line.quantity })),
        },
      }),
    );
    return this.staffView(created);
  }

  /** Approves a REQUESTED item-level return: the customer sends the goods back. */
  async approveReturn(returnRequestId: string, staffNote: string | undefined, actorId: string) {
    const request = await this.findOrThrow(returnRequestId);
    if (request.lines.length === 0) {
      throw new BadRequestException(
        `Return request "${returnRequestId}" is a legacy whole-order request: reject it, or refund the order with refundOrder`,
      );
    }
    return this.move(request, ReturnStatus.APPROVED, [ReturnStatus.REQUESTED], actorId, { staffNote });
  }

  /** Refuses a request, or an approved return whose goods never arrived, with a reason the customer sees. */
  async rejectReturn(returnRequestId: string, reason: string, staffNote: string | undefined, actorId: string) {
    const request = await this.findOrThrow(returnRequestId);
    return this.move(request, ReturnStatus.REJECTED, REJECTABLE_RETURN, actorId, {
      staffNote,
      data: { rejectionReason: reason },
      details: { rejectionReason: reason },
    });
  }

  /** The customer withdraws their own return before the goods arrive back. */
  async cancelReturn(userId: string, returnRequestId: string): Promise<CustomerReturn> {
    const request = await this.repository.findById(returnRequestId);
    if (request?.userId !== userId) throw new NotFoundException(`Return request "${returnRequestId}" not found`);
    assertReturnTransition(returnRequestId, request.status, ReturnStatus.CANCELLED);
    await this.prisma.$transaction(async (tx) => {
      const left = await transitionReturn(tx, returnRequestId, ReturnStatus.CANCELLED, CUSTOMER_CANCELLABLE_RETURN, {
        actorId: userId,
      });
      if (!left) throw this.changedMeanwhile(returnRequestId);
    });
    return this.customerView(await this.findOrThrow(returnRequestId));
  }

  /**
   * Records the goods arriving back: how many units of each line came (0 to its quantity; a short receipt is final:
   * units that never came are not refunded and are no longer under return).
   */
  async receiveReturn(
    returnRequestId: string,
    lines: { returnLineId: string; receivedQuantity: number }[],
    staffNote: string | undefined,
    actorId: string,
  ) {
    const request = await this.findOrThrow(returnRequestId);
    const problem = receiptProblem(request.lines, lines);
    if (problem) throw new BadRequestException(problem);
    return this.move(request, ReturnStatus.RECEIVED, [ReturnStatus.APPROVED], actorId, {
      staffNote,
      details: { lines },
      inTransaction: async (tx) => {
        for (const line of lines) await this.repository.setReceived(tx, line.returnLineId, line.receivedQuantity);
      },
    });
  }

  /**
   * Decides what happens to every unit received: RESTOCK puts it back into sellable stock at the order's location
   * (RETURN_RESTOCK movement referring to the return; a lot-tracked variant into the lot named or the lots the order's
   * sale drew from; a serial-tracked variant names each unit, which must be one sold on this order), WRITE_OFF adds no
   * stock: the units left stock when they were sold, so nothing moves and the disposition stays on the return line.
   */
  async inspectReturn(
    returnRequestId: string,
    lines: {
      returnLineId: string;
      restockQuantity: number;
      writeOffQuantity: number;
      lot?: { lotNumber: string; expiresAt?: Date; manufacturedAt?: Date };
      serials?: string[];
    }[],
    staffNote: string | undefined,
    actorId: string,
  ) {
    const request = await this.findOrThrow(returnRequestId);
    const received = request.lines.map((line) => ({ id: line.id, receivedQuantity: line.receivedQuantity ?? 0 }));
    const problem = inspectionProblem(received, lines);
    if (problem) throw new BadRequestException(problem);
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: request.orderId },
      select: { stockLocationId: true },
    });
    const movements: { returnLineId: string; stockMovementIds: string[]; locationId: string; serials: string[] }[] = [];
    return this.move(request, ReturnStatus.INSPECTED, [ReturnStatus.RECEIVED], actorId, {
      staffNote,
      details: {
        lines: lines.map(({ returnLineId, restockQuantity, writeOffQuantity }) => ({
          returnLineId,
          restockQuantity,
          writeOffQuantity,
        })),
        movements,
      },
      inTransaction: async (tx) => {
        for (const entry of lines) {
          const line = request.lines.find((candidate) => candidate.id === entry.returnLineId)!;
          await this.repository.setDisposition(tx, line.id, entry.restockQuantity, entry.writeOffQuantity);
          if (entry.restockQuantity === 0) {
            if (entry.lot || entry.serials?.length) {
              throw new BadRequestException(`Return line "${line.id}" restocks nothing; leave its lot and serials out`);
            }
            continue;
          }
          const restocked = await this.inventory.restockReturn(
            tx,
            {
              variantId: line.orderItem.variantId,
              quantity: entry.restockQuantity,
              returnRequestId: request.id,
              orderId: request.orderId,
              locationId: order.stockLocationId ?? undefined,
              lot: entry.lot,
              serials: entry.serials,
              note: 'Returned goods restocked after inspection',
            },
            actorId,
          );
          movements.push({
            returnLineId: line.id,
            stockMovementIds: restocked.movements.map((movement) => movement.id),
            locationId: restocked.movements[0].locationId,
            serials: restocked.serials,
          });
        }
      },
    });
  }

  /**
   * Settles an INSPECTED return with a refund of the units received, priced from the order's stored snapshot (never
   * re-priced), the delivery fee only when staff choose it; online through the payment's provider (PENDING -> SENDING
   * -> PROCESSED, return REFUND_PENDING -> REFUNDED), cash on delivery as cash handed back (REFUNDED at once). A legacy
   * whole-order request refunds the amount staff approved for it. Repeated calls never refund twice: a return has at
   * most one refund, claimed before the provider is called.
   */
  async refundReturn(
    returnRequestId: string,
    params: { refundShipping: boolean; staffNote?: string },
    actorId: string,
  ): Promise<ReturnRequestEntity> {
    const request = await this.findOrThrow(returnRequestId);
    if (request.lines.length === 0) {
      await this.refundLegacy(request, actorId);
    } else {
      if (request.status !== ReturnStatus.INSPECTED && request.status !== ReturnStatus.REFUND_PENDING) {
        throw new ConflictException(
          `Return request "${returnRequestId}" is ${request.status}; it is refunded once its goods are received and inspected`,
        );
      }
      await this.refundsService.refundReturnLines(
        request,
        { shipping: params.refundShipping, note: params.staffNote?.trim() || null },
        actorId,
      );
    }
    return this.staffView(await this.findOrThrow(returnRequestId));
  }

  /**
   * Settles an INSPECTED exchange: a replacement order for the customer with the variant wanted for each unit received,
   * at no charge (the returned units paid for it), shipped like any order. Each variant must still be on sale at the
   * price the line was ordered at, and one location serving the original order's zone or pickup point must hold every
   * unit: the stock is reserved there and taken as sold (the order is paid), in one transaction with the return's
   * move to EXCHANGED. Otherwise BAD_REQUEST (EXCHANGE_NOT_ALLOWED / EXCHANGE_OUT_OF_STOCK): refund instead.
   */
  async exchangeReturn(returnRequestId: string, staffNote: string | undefined, actorId: string) {
    const request = await this.findOrThrow(returnRequestId);
    if (request.resolution !== ReturnResolution.EXCHANGE) {
      throw new BadRequestException(
        `Return request "${returnRequestId}" asks for a refund; settle it with refundReturn`,
      );
    }
    assertReturnTransition(returnRequestId, request.status, ReturnStatus.EXCHANGED);
    const wanted = replacementLines(
      request.lines.map((line) => ({
        orderItemId: line.orderItemId,
        exchangeVariantId: line.exchangeVariantId,
        receivedQuantity: line.receivedQuantity,
      })),
    );
    if (wanted.length === 0) throw new BadRequestException('No units were received: there is nothing to exchange');
    let replacementOrderId = '';
    return this.move(request, ReturnStatus.EXCHANGED, [ReturnStatus.INSPECTED], actorId, {
      staffNote,
      lockFirst: true,
      data: () => ({ replacementOrderId }),
      details: () => ({ replacementOrderId, lines: wanted }),
      inTransaction: async (tx) => {
        replacementOrderId = await this.placeReplacement(tx, request, wanted, actorId);
      },
    });
  }

  async findMyReturns(userId: string, first: number, after?: string): Promise<Page<CustomerReturn>> {
    const page = await this.page({ userId }, first, after);
    return { ...page, nodes: page.nodes.map((request) => this.customerView(request)) };
  }

  async findReturns(filter: ReturnFilter, first: number, after?: string): Promise<Page<ReturnRequestEntity>> {
    if (filter.createdFrom && filter.createdTo && filter.createdFrom >= filter.createdTo) {
      throw new BadRequestException('createdFrom must be before createdTo');
    }
    const page = await this.page(filter, first, after);
    return { ...page, nodes: page.nodes.map((request) => this.staffView(request)) };
  }

  async findReturn(returnRequestId: string): Promise<ReturnRequestEntity> {
    return this.staffView(await this.findOrThrow(returnRequestId));
  }

  async findRefund(returnRequestId: string): Promise<Refund | null> {
    return this.refundRepository.findByReturnRequest(returnRequestId);
  }

  private async page(filter: ReturnFilter, first: number, after?: string): Promise<Page<ReturnWithLines>> {
    const take = Math.min(first, MAX_PAGE_SIZE);
    const [rows, totalCount] = await this.repository.findMany(filter, { take: take + 1, after });
    return { nodes: rows.slice(0, take), totalCount, hasNextPage: rows.length > take };
  }

  /** Validates the lines against the order's deliveries, refunds, other returns and (unless overridden) the policy. */
  private async checkRequest(
    tx: Tx,
    params: ReturnRequestParams,
    policyOverride: boolean,
  ): Promise<CheckedReturnLine[]> {
    const lines = checkReturnLines(params.orderId, params.resolution, params.lines);
    if (typeof lines === 'string') throw new BadRequestException(lines);
    const orderLines = await this.repository.returnableLines(tx, params.orderId);
    const storeWindowDays = await this.repository.storeWindowDays(tx);
    const now = new Date();
    for (const line of lines) {
      const orderLine = orderLines.find((candidate) => candidate.id === line.orderItemId);
      if (!orderLine) throw new BadRequestException(`Order line "${line.orderItemId}" is not part of this order`);
      const refusal = returnLineRefusal(
        { orderItemId: line.orderItemId, productName: orderLine.productName, quantity: line.quantity },
        orderLine.units,
        { storeWindowDays, productType: orderLine.productType },
        now,
        policyOverride,
      );
      if (refusal) {
        const body = { message: refusal.message, extensions: { reason: refusal.reason } };
        throw refusal.kind === 'CONFLICT' ? new ConflictException(body) : new BadRequestException(body);
      }
    }
    if (params.resolution === ReturnResolution.EXCHANGE) await this.checkExchange(tx, lines, orderLines);
    return lines;
  }

  private async checkExchange(
    tx: Tx,
    lines: { orderItemId: string; exchangeVariantId: string | null }[],
    orderLines: { id: string; productId: string; unitListPrice: Prisma.Decimal }[],
  ): Promise<void> {
    const ids = [...new Set(lines.map((line) => line.exchangeVariantId!))];
    const variants = await this.repository.findVariants(tx, ids);
    for (const line of lines) {
      const variant = variants.find((candidate) => candidate.id === line.exchangeVariantId);
      if (!variant) throw new NotFoundException(`Variant "${line.exchangeVariantId}" not found`);
      const orderLine = orderLines.find((candidate) => candidate.id === line.orderItemId)!;
      const refusal = exchangeRefusal(
        { orderItemId: orderLine.id, productId: orderLine.productId, unitListPrice: orderLine.unitListPrice },
        { id: variant.id, productId: variant.productId, price: variant.price, notSellable: notSellableReason(variant) },
      );
      if (refusal) throw new BadRequestException({ message: refusal, extensions: { reason: EXCHANGE_NOT_ALLOWED } });
    }
  }

  /** Writes the replacement order of an exchange with its stock reserved and taken as sold; returns its id. */
  private async placeReplacement(
    tx: Tx,
    request: ReturnWithLines,
    wanted: { orderItemId: string; variantId: string; quantity: number }[],
    actorId: string,
  ): Promise<string> {
    const original = await this.repository.lockOrder(tx, request.orderId);
    if (!original) throw new NotFoundException(`Order "${request.orderId}" not found`);
    const orderLines = await this.repository.returnableLines(tx, request.orderId);
    await this.checkExchange(
      tx,
      wanted.map((line) => ({ orderItemId: line.orderItemId, exchangeVariantId: line.variantId })),
      orderLines,
    );
    const variants = await this.repository.findVariants(tx, [...new Set(wanted.map((line) => line.variantId))]);
    const candidates = original.shippingZoneId
      ? await this.stockLocations.candidatesFor({ shippingZoneId: original.shippingZoneId }, tx)
      : original.pickupLocationId
        ? await this.stockLocations.candidatesFor({ pickupLocationId: original.pickupLocationId }, tx)
        : [await this.ledgerRepository.defaultLocationId(tx)];
    const chosen = await this.stockLocations.lockFulfilmentLocation(tx, candidates, wanted);
    if (chosen.locationId === null) throw this.exchangeOutOfStock();
    const replacement = await this.ordersRepository.createReplacement(
      tx,
      original,
      wanted.map((line) => {
        const variant = variants.find((candidate) => candidate.id === line.variantId)!;
        return {
          productId: variant.productId,
          variantId: variant.id,
          productName: variant.product.name,
          sku: variant.sku,
          optionValues: variant.optionValues,
          quantity: line.quantity,
        };
      }),
      chosen.locationId,
      PRICING_VERSION,
    );
    for (const item of replacement.items) {
      const reserved =
        (await this.ordersRepository.lockSellableVariant(tx, item.variantId)) &&
        (await this.ledger.reserve(
          tx,
          {
            variantId: item.variantId,
            quantity: item.quantity,
            orderId: replacement.id,
            orderItemId: item.id,
            expiresAt: null,
            locationId: chosen.locationId,
          },
          actorId,
        ));
      if (!reserved) throw this.exchangeOutOfStock();
    }
    await this.ledger.consumeOrder(tx, replacement.id, actorId);
    const confirmed = await transitionOrder(tx, replacement.id, OrderStatus.CONFIRMED, [OrderStatus.PLACED], {
      actorId,
      reason: `Replacement for return request ${request.id}: paid by the returned units`,
    });
    if (!confirmed) throw new ConflictException(`Replacement order "${replacement.id}" changed while it was placed`);
    await this.outbox.record(tx, {
      type: 'order.placed.v1',
      aggregateId: replacement.id,
      payload: { orderId: replacement.id },
    });
    return replacement.id;
  }

  private async refundLegacy(request: ReturnWithLines, actorId: string): Promise<void> {
    const refundId =
      request.status === ReturnStatus.REFUND_PENDING
        ? await this.legacyRefundId(request)
        : await this.openLegacyRefund(request, actorId);
    await this.refundsService.send(refundId, actorId);
  }

  private async openLegacyRefund(request: ReturnRequest, actorId: string): Promise<string> {
    if (request.status !== ReturnStatus.APPROVED) {
      throw new BadRequestException('Only approved return requests can be refunded');
    }
    const { refundAmount } = request;
    if (!refundAmount || refundAmount.lte(0)) {
      throw new BadRequestException('Refund amount not set');
    }
    // The attempt that paid the order comes first; a late duplicate charge flagged for review is refunded on its own.
    const payment = await this.prisma.paymentAttempt.findFirst({
      where: { intent: { orderId: request.orderId }, status: PaymentStatus.CAPTURED, reference: { not: null } },
      orderBy: [{ reviewReason: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
    });
    if (!payment?.reference) {
      throw new BadRequestException('No payment transaction found for this order');
    }
    const refund = await this.refundsService.openForReturn({ ...request, refundAmount }, payment.id, actorId);
    return refund.id;
  }

  private async legacyRefundId(request: ReturnRequest): Promise<string> {
    const refund = await this.refundRepository.findByReturnRequest(request.id);
    if (!refund) {
      throw new ConflictException(`Return request "${request.id}" is REFUND_PENDING but has no refund`);
    }
    return refund.id;
  }

  /**
   * A staff move: the conditional transition with its history event, the step's own writes, the audit row and (for
   * statuses the customer hears about) the outbox event, in one transaction. `lockFirst` takes the request's row lock
   * before the step's writes, for steps that must not run twice in parallel (the exchange's replacement order).
   */
  private async move(
    request: ReturnWithLines,
    to: ReturnStatus,
    from: ReturnStatus[],
    actorId: string,
    step: {
      staffNote?: string;
      data?: Prisma.ReturnRequestUncheckedUpdateManyInput | (() => Prisma.ReturnRequestUncheckedUpdateManyInput);
      details?: Record<string, unknown> | (() => Record<string, unknown>);
      inTransaction?: (tx: Tx) => Promise<void>;
      lockFirst?: boolean;
    },
  ): Promise<ReturnRequestEntity> {
    assertReturnTransition(request.id, request.status, to);
    if (!from.includes(request.status)) {
      throw new ConflictException(`Return request "${request.id}" is ${request.status}; expected ${from.join(' or ')}`);
    }
    // Only from the status the staff member acted on: a return another request moved meanwhile is a CONFLICT, even
    // when the new status would also allow this step (e.g. a reject racing an approval).
    const seen = [request.status];
    const staffNote = step.staffNote?.trim() || null;
    await this.prisma.$transaction(async (tx) => {
      if (step.lockFirst) {
        const [current] = await tx.$queryRaw<{ status: ReturnStatus }[]>`
          SELECT "status" FROM "ReturnRequest" WHERE "id" = ${request.id} FOR UPDATE`;
        if (!current || !seen.includes(current.status)) throw this.changedMeanwhile(request.id);
      }
      await step.inTransaction?.(tx);
      const data = typeof step.data === 'function' ? step.data() : step.data;
      const left = await transitionReturn(tx, request.id, to, seen, {
        actorId,
        note: staffNote,
        data: { ...data, ...(staffNote && { staffNote }) },
      });
      if (!left) throw this.changedMeanwhile(request.id);
      const details = typeof step.details === 'function' ? step.details() : step.details;
      await this.auditService.log(
        {
          entity: 'ReturnRequest',
          entityId: request.id,
          action: 'STATUS_CHANGE',
          userId: actorId,
          details: JSON.parse(JSON.stringify({ orderId: request.orderId, from: left, to, ...details })),
        },
        tx,
      );
      if (to !== ReturnStatus.INSPECTED) await this.notify(tx, request, to as NotifiedStatus);
    });
    return this.staffView(await this.findOrThrow(request.id));
  }

  private async notify(tx: Tx, request: ReturnRequest, status: NotifiedStatus): Promise<void> {
    await this.outbox.record(tx, {
      type: 'return.status_changed.v1',
      aggregateId: request.id,
      payload: { returnRequestId: request.id, orderId: request.orderId, status },
    });
  }

  private async findOrThrow(id: string): Promise<ReturnWithLines> {
    const request = await this.repository.findById(id);
    if (!request) throw new NotFoundException(`Return request "${id}" not found`);
    return request;
  }

  private changedMeanwhile(id: string): ConflictException {
    return new ConflictException(`Return request "${id}" was changed by another request; reload it and try again`);
  }

  private exchangeOutOfStock(): BadRequestException {
    return new BadRequestException({
      message: 'The variants wanted are not in stock at one location serving this order: refund the return instead',
      extensions: { reason: EXCHANGE_OUT_OF_STOCK },
    });
  }

  private lineView(line: ReturnWithLines['lines'][number]): ReturnLine {
    return {
      id: line.id,
      orderItemId: line.orderItemId,
      productName: line.orderItem.productName,
      sku: line.orderItem.sku,
      quantity: line.quantity,
      reason: line.reason,
      note: line.note,
      photoUrls: line.photoPublicIds.map((publicId) => this.cloudinary.urlFor(publicId)),
      exchangeVariantId: line.exchangeVariantId,
      receivedQuantity: line.receivedQuantity,
    };
  }

  private customerView(request: ReturnWithLines): CustomerReturn {
    return {
      id: request.id,
      orderId: request.orderId,
      status: request.status,
      resolution: request.resolution,
      rejectionReason: request.rejectionReason,
      replacementOrderId: request.replacementOrderId,
      lines: request.lines.map((line) => this.lineView(line)),
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
    };
  }

  private staffView(request: ReturnWithLines): ReturnRequestEntity {
    return {
      id: request.id,
      orderId: request.orderId,
      userId: request.userId,
      status: request.status,
      resolution: request.resolution,
      legacy: request.lines.length === 0,
      reason: request.reason,
      refundAmount: request.refundAmount,
      staffNote: request.staffNote,
      rejectionReason: request.rejectionReason,
      policyOverrideReason: request.policyOverrideReason,
      createdById: request.createdById,
      replacementOrderId: request.replacementOrderId,
      lines: request.lines.map((line): StaffReturnLine => ({
        ...this.lineView(line),
        photoPublicIds: line.photoPublicIds,
        restockQuantity: line.restockQuantity,
        writeOffQuantity: line.writeOffQuantity,
      })),
      events: request.events,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
    };
  }
}
