export const PROCESS_ROLES = ['api', 'worker'] as const;

export type ProcessRole = (typeof PROCESS_ROLES)[number];

/**
 * Which process to start from one image: the HTTP/GraphQL API (default) or the background worker. A `--role=<role>`
 * argument wins over the ROLE variable, so `npm run start:worker` works in every shell.
 */
export function selectProcessRole(roleVariable: string | undefined, args: readonly string[]): ProcessRole {
  const argument = args.find((arg) => arg.startsWith('--role='))?.slice('--role='.length);
  const role = argument ?? roleVariable ?? 'api';
  if (!(PROCESS_ROLES as readonly string[]).includes(role)) {
    throw new Error(`Unknown process role "${role}": set ROLE (or --role=) to one of ${PROCESS_ROLES.join(', ')}`);
  }
  return role as ProcessRole;
}
