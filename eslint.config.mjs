import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';

export default defineConfig(
  globalIgnores(['src/generated/**']),
  tseslint.configs.recommended,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      sourceType: 'module',
      parserOptions: {
        project: 'tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // typescript-eslint 8 dropped its no-loss-of-precision from recommended in favour of this core rule.
      'no-loss-of-precision': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // ADR-0004: money is exact Decimal on these paths. Converting to a JS number loses cents, so it is banned;
    // a legitimate non-money use (a count, a provider's integer minor units) carries a disable comment saying why.
    files: [
      'src/{analytics,cart,coupons,discount,order,payment,returns,shipping-zones,tax,store}/**/*.ts',
      'src/commons/money/**/*.ts',
      'src/products/loaders/discount.loader.ts',
      'src/products/products.resolver.ts',
    ],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='Number']",
          message: 'No Number() on the money path: keep amounts as Prisma Decimal or Money (ADR-0004).',
        },
        {
          selector:
            'CallExpression[callee.name=/^parse(Float|Int)$/], CallExpression[callee.property.name=/^parse(Float|Int)$/]',
          message: 'No parseFloat/parseInt on the money path: parse amounts with new Prisma.Decimal (ADR-0004).',
        },
        {
          selector: "CallExpression[callee.property.name='toNumber']",
          message: 'No .toNumber() on the money path: keep amounts as Prisma Decimal or Money (ADR-0004).',
        },
      ],
    },
  },
);
