import { Field, ObjectType } from '@nestjs/graphql';

const ANONYMOUS_DISPLAY_NAME = 'Customer';

@ObjectType({ description: 'What other customers may see about a user, e.g. on reviews' })
export class PublicProfile {
  @Field(() => String, { description: 'First name and last initial, e.g. "Kwame A."' })
  displayName: string;
}

export function toPublicProfile(user: { name?: string | null } | null | undefined): PublicProfile {
  const parts = user?.name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (parts.length === 0) return { displayName: ANONYMOUS_DISPLAY_NAME };
  if (parts.length === 1) return { displayName: parts[0] };
  const lastInitial = parts[parts.length - 1][0].toUpperCase();
  return { displayName: `${parts[0]} ${lastInitial}.` };
}
