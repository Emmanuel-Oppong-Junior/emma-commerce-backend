const TEST_DATABASE_SUFFIX = '_test';

export function assertTestDatabaseUrl(databaseUrl: string | undefined): void {
  if (!databaseUrl) {
    throw new Error('Refusing to run e2e tests: DATABASE_URL is not set. Define it in .env.test.');
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('Refusing to run e2e tests: DATABASE_URL is not a valid URL. Check .env.test.');
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!databaseName.endsWith(TEST_DATABASE_SUFFIX)) {
    throw new Error(
      `Refusing to run e2e tests: database "${databaseName}" does not end in "${TEST_DATABASE_SUFFIX}". ` +
        'Point DATABASE_URL in .env.test at a test database.',
    );
  }
}
