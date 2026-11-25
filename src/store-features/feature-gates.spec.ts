import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RESOLVER_NAME_METADATA, RESOLVER_TYPE_METADATA } from '@nestjs/graphql';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FEATURE_KEY } from './require-feature';
import { STORE_FEATURE_KEYS, STORE_FEATURES, StoreFeatureKey } from './store-feature-registry';

// Which operations each store feature gates (P8-F), read from the @RequireFeature metadata like the authorization matrix
// reads policies. A new operation in a feature's resolver or controller fails here until it is gated or listed as open.

const SRC_DIR = join(__dirname, '..');

type ClassRef = { prototype: object; name: string };

interface Operation {
  name: string;
  owner: string;
  feature?: StoreFeatureKey;
}

/** The resolvers and controllers each feature owns, and their operations that deliberately stay open while it is off. */
const FEATURE_OWNERS: Record<StoreFeatureKey, { classes: string[]; open: Record<string, string> }> = {
  GUEST_CHECKOUT: {
    classes: ['GuestCheckoutResolver', 'GuestPaymentController'],
    open: {
      'Query guestCart': 'reads an existing cart',
      'Query guestOrder': 'orders already placed stay readable',
      'Mutation verifyGuestPayment': 'orders already placed can still be paid',
      'REST POST /payment/guest/initialize': 'orders already placed can still be paid',
    },
  },
  LOYALTY: {
    classes: ['LoyaltyResolver'],
    open: {
      'Query myLoyalty': "the customer's balance stays readable",
      'Query loyaltySettings': 'public; reports enabled',
      'Query customerLoyalty': 'staff',
      'Mutation adjustLoyaltyPoints': 'staff corrections continue',
      'Mutation updateLoyaltySettings': 'staff configure the programme before switching it on',
    },
  },
  REFERRALS: {
    classes: ['ReferralsResolver'],
    open: { 'Query customerReferrals': 'staff' },
  },
  REVIEWS: {
    classes: ['ReviewResolver', 'ReviewPhotoController'],
    open: {
      'Query review': 'published reviews stay readable',
      'Query productReviews': 'published reviews stay readable',
      'Query userReviews': "the author's reviews stay readable",
      'Query reportedReviews': 'staff moderation',
      'Mutation hideReview': 'staff moderation',
      'Mutation unhideReview': 'staff moderation',
      'Mutation dismissReviewReports': 'staff moderation',
      'Mutation replyToReview': 'staff moderation',
    },
  },
  PRODUCT_QA: {
    classes: ['ProductQuestionsResolver'],
    open: {
      'Query productQuestions': 'answered questions stay readable',
      'Query productQuestion': 'answered questions stay readable',
      'Query myProductQuestions': "the asker's questions stay readable",
      'Query unansweredProductQuestions': 'staff',
      'Query reportedProductQuestions': 'staff',
      'Mutation answerProductQuestion': 'staff',
      'Mutation hideProductQuestion': 'staff moderation',
      'Mutation unhideProductQuestion': 'staff moderation',
      'Mutation dismissProductQuestionReports': 'staff moderation',
    },
  },
  RECENTLY_VIEWED: {
    classes: ['RecentlyViewedResolver'],
    open: { 'Query recentlyViewed': 'the list recorded so far stays readable' },
  },
  RETURNS: {
    classes: ['ReturnsResolver', 'ReturnPhotoController'],
    open: {
      'Query myReturns': "the customer's returns stay readable",
      'Query returns': 'staff',
      'Query returnRequest': 'staff',
      'Mutation acceptReturnOutsidePolicy': 'staff',
      'Mutation approveReturn': 'staff finish open returns',
      'Mutation rejectReturn': 'staff finish open returns',
      'Mutation receiveReturn': 'staff finish open returns',
      'Mutation inspectReturn': 'staff finish open returns',
      'Mutation refundReturn': 'staff finish open returns',
      'Mutation exchangeReturn': 'staff finish open returns',
    },
  },
  ABANDONED_CART_REMINDERS: { classes: [], open: {} },
  SAVED_FOR_LATER: {
    classes: ['SavedItemsResolver'],
    open: { 'Query savedItems': 'saved items stay readable' },
  },
  WISHLIST: {
    classes: ['WishlistResolver'],
    open: { 'Query wishlist': 'the wishlist stays readable' },
  },
  CASH_ON_DELIVERY: { classes: [], open: {} },
};

async function loadClasses(suffix: string, nameSuffix: string): Promise<ClassRef[]> {
  const files = readdirSync(SRC_DIR, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith(suffix));
  const modules: Record<string, unknown>[] = await Promise.all(files.map((file) => import(join(SRC_DIR, file))));
  return modules.flatMap((exports) =>
    Object.values(exports).filter(
      (value): value is ClassRef => typeof value === 'function' && value.name.endsWith(nameSuffix),
    ),
  );
}

function methodsOf(cls: ClassRef): [string, object][] {
  return Object.getOwnPropertyNames(cls.prototype)
    .filter((key) => key !== 'constructor')
    .map((key) => [key, (cls.prototype as Record<string, object>)[key]] as [string, object])
    .filter(([, method]) => typeof method === 'function');
}

function featureOf(method: object, cls: ClassRef): StoreFeatureKey | undefined {
  return Reflect.getMetadata(FEATURE_KEY, method) ?? Reflect.getMetadata(FEATURE_KEY, cls);
}

function joinPath(...segments: (string | undefined)[]): string {
  return `/${segments
    .flatMap((segment) => (segment ?? '').split('/'))
    .filter(Boolean)
    .join('/')}`;
}

function operationsOf(resolvers: ClassRef[], controllers: ClassRef[]): Operation[] {
  const graphql = resolvers.flatMap((cls) =>
    methodsOf(cls).flatMap(([key, method]) => {
      const type = Reflect.getMetadata(RESOLVER_TYPE_METADATA, method);
      if (type !== 'Query' && type !== 'Mutation') return [];
      const name = `${type} ${Reflect.getMetadata(RESOLVER_NAME_METADATA, method) ?? key}`;
      return [{ name, owner: cls.name, feature: featureOf(method, cls) }];
    }),
  );
  const rest = controllers.flatMap((cls) => {
    const base = Reflect.getMetadata(PATH_METADATA, cls) as string | undefined;
    return methodsOf(cls).flatMap(([, method]) => {
      const verb = Reflect.getMetadata(METHOD_METADATA, method) as RequestMethod | undefined;
      if (verb === undefined) return [];
      const name = `REST ${RequestMethod[verb]} ${joinPath(base, Reflect.getMetadata(PATH_METADATA, method))}`;
      return [{ name, owner: cls.name, feature: featureOf(method, cls) }];
    });
  });
  return [...graphql, ...rest];
}

describe('Store feature gates', () => {
  let operations: Operation[];

  beforeAll(async () => {
    const [resolvers, controllers] = await Promise.all([
      loadClasses('.resolver.ts', 'Resolver'),
      loadClasses('.controller.ts', 'Controller'),
    ]);
    operations = operationsOf(resolvers, controllers);
  });

  it('describes every feature, all on by default', () => {
    expect([...STORE_FEATURE_KEYS].sort()).toEqual(Object.values(StoreFeatureKey).sort());
    for (const key of STORE_FEATURE_KEYS) {
      expect(STORE_FEATURES[key].description.length).toBeGreaterThan(0);
      expect(STORE_FEATURES[key].defaultEnabled).toBe(true);
    }
  });

  it('gates exactly the operations the registry lists', () => {
    for (const key of STORE_FEATURE_KEYS) {
      const decorated = operations.filter((operation) => operation.feature === key).map((operation) => operation.name);
      expect({ key, operations: decorated.sort() }).toEqual({
        key,
        operations: [...STORE_FEATURES[key].operations].sort(),
      });
    }
  });

  it("gates or deliberately leaves open every operation of a feature's resolvers and controllers", () => {
    for (const [key, owners] of Object.entries(FEATURE_OWNERS)) {
      const owned = operations.filter((operation) => owners.classes.includes(operation.owner));
      expect(new Set(owned.map((operation) => operation.owner))).toEqual(new Set(owners.classes));
      const unclassified = owned
        .filter((operation) => operation.feature !== key && !(operation.name in owners.open))
        .map((operation) => operation.name);
      expect({ key, unclassified }).toEqual({ key, unclassified: [] });
      const staleOpen = Object.keys(owners.open).filter(
        (name) => !owned.some((operation) => operation.name === name && operation.feature === undefined),
      );
      expect({ key, staleOpen }).toEqual({ key, staleOpen: [] });
    }
  });

  it('matches the reviewed list of gated operations', () => {
    const table = STORE_FEATURE_KEYS.flatMap((key) =>
      operations
        .filter((operation) => operation.feature === key)
        .map((operation) => `${key.padEnd(26)} ${operation.name}`)
        .sort(),
    ).join('\n');

    expect(`\n${table}\n`).toMatchSnapshot();
  });
});
