import { Field, ObjectType } from '@nestjs/graphql';
import { Address } from '../../addresses/entities/address.entity';
import { Order } from '../../order/entities/order.entity';
import { ownerOrAdmin } from '../../iam/authorization/owner-or-admin.field-middleware';

const selfOrAdmin = ownerOrAdmin<User>((user) => user.id);

@ObjectType()
export class User {
  @Field({ description: 'Unique identifier for the user' })
  id: string;

  @Field(() => String, { description: 'User’s full name', nullable: true })
  name: string;

  @Field(() => String, { description: 'Email address', middleware: [selfOrAdmin] })
  email: string;

  @Field(() => Boolean, {
    description: 'Whether the current email address has been verified',
    middleware: [selfOrAdmin],
  })
  emailVerified?: boolean;

  @Field(() => String, {
    nullable: true,
    description: 'New email address awaiting verification; the account keeps `email` until it is verified',
    middleware: [selfOrAdmin],
  })
  pendingEmail?: string;

  @Field(() => String, { nullable: true, description: 'Phone number', middleware: [selfOrAdmin] })
  phoneNumber?: string;

  @Field(() => String, {
    nullable: true,
    description: 'Google ID for social login',
  })
  authProvider?: string;

  @Field(() => String, {
    nullable: true,
    description: 'Facebook ID for social login',
  })
  facebookId?: string;

  @Field(() => Boolean, { description: 'Account activation status' })
  isActive: boolean;

  @Field(() => String, { nullable: true, description: 'Profile picture URL' })
  profilePicture?: string;

  @Field(() => String, {
    description: 'Legacy role: SUPER_ADMIN for an Owner, ADMIN for any other staff role, USER for customers',
    deprecationReason: 'Use staffRole and permissions; role is kept in step for old clients only',
  })
  role: string;

  @Field(() => Date, { description: 'Date of account creation' })
  createdAt: Date;

  @Field(() => Date, { description: 'Date of last update' })
  updatedAt: Date;

  @Field(() => Date, { nullable: true, description: 'Date of last login' })
  lastLoginAt?: Date;

  @Field(() => [Address], { nullable: true, description: 'Saved addresses for this user' })
  addresses?: Address[];

  @Field(() => [Order], { nullable: true, description: 'Orders placed by this user' })
  orders?: Order[];
}
