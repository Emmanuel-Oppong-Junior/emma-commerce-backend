import { Field, GraphQLISODateTime, ID, ObjectType } from '@nestjs/graphql';
import { User } from '../../entities/user.entity';

@ObjectType('StaffRole', { description: 'A staff role: a named set of permissions (staff only)' })
export class StaffRoleEntity {
  @Field(() => ID)
  id: string;

  @Field({ description: 'Stable key, e.g. OWNER, MANAGER or a custom key' })
  key: string;

  @Field()
  name: string;

  @Field(() => [String], { description: 'Effective permissions; the Owner always holds every permission' })
  permissions: string[];

  @Field({ description: 'System roles are seeded and cannot be changed' })
  isSystem: boolean;

  @Field({ description: 'Holders must enrol two-factor authentication before using staff operations' })
  mfaRequired: boolean;

  @Field(() => GraphQLISODateTime)
  createdAt: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt: Date;
}

@ObjectType('StaffPermission', { description: 'A permission from the code catalogue' })
export class StaffPermissionEntity {
  @Field({ description: 'Permission key, e.g. order.refund' })
  key: string;

  @Field()
  description: string;
}

@ObjectType('StaffMember', { description: "A user's staff role in the store" })
export class StaffMemberEntity {
  @Field(() => User)
  user: User;

  @Field(() => StaffRoleEntity)
  role: StaffRoleEntity;

  @Field(() => GraphQLISODateTime, { description: 'When the current role was assigned' })
  updatedAt: Date;
}
