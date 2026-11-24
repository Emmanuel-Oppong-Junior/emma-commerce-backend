import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { Decimal } from '@prisma/client/runtime/client';
import { MoneyObject } from '../../commons/money/money.object';
import { ReturnReason, ReturnResolution, ReturnStatus } from '../enums/return.enums';

@ObjectType({ description: 'Units of one order line under a return, as the customer sees them' })
export class ReturnLine {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  orderItemId: string;

  @Field({ description: 'The product name when ordered' })
  productName: string;

  @Field(() => String, { nullable: true, description: 'The SKU when ordered' })
  sku: string | null;

  @Field(() => Int)
  quantity: number;

  @Field(() => ReturnReason)
  reason: ReturnReason;

  @Field(() => String, { nullable: true, description: "The customer's note" })
  note: string | null;

  @Field(() => [String], { description: "URLs of the customer's photos" })
  photoUrls: string[];

  @Field(() => ID, { nullable: true, description: 'The variant wanted instead (exchange)' })
  exchangeVariantId: string | null;

  @Field(() => Int, { nullable: true, description: 'Units that arrived back; null until the return is received' })
  receivedQuantity: number | null;
}

@ObjectType({ description: 'A return line with what staff decided for its units' })
export class StaffReturnLine extends ReturnLine {
  @Field(() => [String], { description: 'Cloudinary public ids of the photos' })
  photoPublicIds: string[];

  @Field(() => Int, { nullable: true, description: 'Units put back into stock; null until inspected' })
  restockQuantity: number | null;

  @Field(() => Int, { nullable: true, description: 'Units written off; null until inspected' })
  writeOffQuantity: number | null;
}

@ObjectType({ description: "A step of a return's history" })
export class ReturnStatusEvent {
  @Field(() => ID)
  id: string;

  @Field(() => ReturnStatus, { nullable: true, description: 'Null for the first step' })
  from: ReturnStatus | null;

  @Field(() => ReturnStatus)
  to: ReturnStatus;

  @Field(() => ID, { nullable: true, description: 'The customer or staff member; null for the system' })
  actorId: string | null;

  @Field(() => String, { nullable: true, description: 'Staff note or reason given' })
  note: string | null;

  @Field()
  createdAt: Date;
}

/** A return as its customer sees it: no staff notes, override reason, history actors or dispositions. */
@ObjectType({ description: 'A return of some delivered units of one of your orders' })
export class CustomerReturn {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  orderId: string;

  @Field(() => ReturnStatus)
  status: ReturnStatus;

  @Field(() => ReturnResolution)
  resolution: ReturnResolution;

  @Field(() => String, { nullable: true, description: 'Why staff refused it' })
  rejectionReason: string | null;

  @Field(() => ID, { nullable: true, description: 'The replacement order of an exchange' })
  replacementOrderId: string | null;

  @Field(() => [ReturnLine])
  lines: ReturnLine[];

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}

@ObjectType('ReturnRequest', { description: 'A return request with everything staff see' })
export class ReturnRequestEntity {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  orderId: string;

  @Field(() => ID)
  userId: string;

  @Field(() => ReturnStatus)
  status: ReturnStatus;

  @Field(() => ReturnResolution)
  resolution: ReturnResolution;

  @Field({ description: 'A whole-order request from before item-level returns: no lines, a free-text reason' })
  legacy: boolean;

  @Field(() => String, { nullable: true, description: 'The free-text reason of a legacy request' })
  reason: string | null;

  @Field(() => MoneyObject, { nullable: true, description: 'The amount approved for a legacy request' })
  refundAmount: Decimal | null;

  @Field(() => String, { nullable: true, description: 'Internal note (latest); never shown to the customer' })
  staffNote: string | null;

  @Field(() => String, { nullable: true, description: 'Why it was refused; shown to the customer' })
  rejectionReason: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'Why staff accepted it outside the return window or for a non-returnable product',
  })
  policyOverrideReason: string | null;

  @Field(() => ID, { nullable: true, description: 'The staff member who created it for the customer' })
  createdById: string | null;

  @Field(() => ID, { nullable: true, description: 'The replacement order of an exchange' })
  replacementOrderId: string | null;

  @Field(() => [StaffReturnLine])
  lines: StaffReturnLine[];

  @Field(() => [ReturnStatusEvent], { description: 'Status history, oldest first' })
  events: ReturnStatusEvent[];

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}

@ObjectType()
export class CustomerReturnPage {
  @Field(() => [CustomerReturn])
  nodes: CustomerReturn[];

  @Field(() => Int)
  totalCount: number;

  @Field({ description: 'Pass the last node id as `after` to read the next page' })
  hasNextPage: boolean;
}

@ObjectType()
export class ReturnRequestPage {
  @Field(() => [ReturnRequestEntity])
  nodes: ReturnRequestEntity[];

  @Field(() => Int)
  totalCount: number;

  @Field({ description: 'Pass the last node id as `after` to read the next page' })
  hasNextPage: boolean;
}
