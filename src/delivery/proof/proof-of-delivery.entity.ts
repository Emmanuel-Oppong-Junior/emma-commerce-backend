import { Field, Float, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { ProofOfDeliveryMethod } from '../../generated/prisma/client';

registerEnumType(ProofOfDeliveryMethod, {
  name: 'ProofOfDeliveryMethod',
  description:
    'CODE: the customer gave the rider the code texted at dispatch; OVERRIDE: staff confirmed it without one',
});

@ObjectType({ description: 'How a rider’s delivery was confirmed (staff)' })
export class ProofOfDeliveryEntity {
  @Field(() => ID)
  id: string;

  @Field(() => ProofOfDeliveryMethod)
  method: ProofOfDeliveryMethod;

  @Field(() => String, { nullable: true, description: 'Why staff confirmed it without the code' })
  overrideReason: string | null;

  @Field(() => ID, { description: 'The rider, or the staff member who overrode' })
  deliveredById: string;

  @Field()
  deliveredAt: Date;

  @Field(() => String, { nullable: true })
  photoUrl: string | null;

  @Field(() => String, { nullable: true })
  recipientName: string | null;

  @Field(() => Float, { nullable: true })
  latitude: number | null;

  @Field(() => Float, { nullable: true })
  longitude: number | null;
}

@ObjectType({ description: 'That a delivery was confirmed, and how (what the customer sees)' })
export class DeliveryConfirmation {
  @Field(() => ProofOfDeliveryMethod)
  method: ProofOfDeliveryMethod;

  @Field()
  confirmedAt: Date;
}
