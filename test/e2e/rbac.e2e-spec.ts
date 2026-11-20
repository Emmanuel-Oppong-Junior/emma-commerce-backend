import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ALL_PERMISSIONS } from '../../src/iam/authorization/permissions';
import { base32Decode, totp } from '../../src/iam/mfa/totp';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal, staffMembershipBackfillSql } from '../helpers/db.helper';
import { signInAdmin, signInSuperAdmin, signInUser, signUpUser } from '../helpers/auth.helper';
import { MANAGER_PERMISSIONS } from '../helpers/staff.helper';

describe('Permission-based RBAC (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ownerToken: string;
  let managerToken: string;
  let customerToken: string;

  const gql = (query: string, token?: string, variables?: Record<string, unknown>) =>
    gqlRequest(app, query, variables, token).expect(200);
  const assign = (userId: string, roleKey: string, token: string) =>
    gql(
      `mutation { assignStaffRole(userId: "${userId}", roleKey: "${roleKey}") { role { key } user { id role } } }`,
      token,
    );
  const roleOf = async (userId: string) =>
    (await prisma.storeMembership.findFirst({ where: { userId }, include: { role: true } }))?.role.key ?? null;
  const newCustomer = async (email: string) => {
    const tokens = await signUpUser(app, { email, password: 'Passw0rd!x', name: 'Staff To Be' });
    const { id } = await prisma.user.findUniqueOrThrow({ where: { email } });
    return { id, token: tokens.accessToken };
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    ownerToken = await signInSuperAdmin(app);
    managerToken = await signInAdmin(app);
    customerToken = await signInUser(app);
  });

  afterAll(() => app.close());

  describe('migration', () => {
    it('backfills SUPER_ADMIN to Owner and ADMIN to Manager, leaves customers alone, and is safe to re-run', async () => {
      await prisma.user.createMany({
        data: [
          { id: 'legacy_super', email: 'legacy-super@example.com', role: 'SUPER_ADMIN' },
          { id: 'legacy_admin', email: 'legacy-admin@example.com', role: 'ADMIN' },
          { id: 'legacy_user', email: 'legacy-user@example.com', role: 'USER' },
        ],
      });

      await prisma.$executeRawUnsafe(staffMembershipBackfillSql());
      await prisma.$executeRawUnsafe(staffMembershipBackfillSql());

      expect(await roleOf('legacy_super')).toBe('OWNER');
      expect(await roleOf('legacy_admin')).toBe('MANAGER');
      expect(await roleOf('legacy_user')).toBeNull();
      expect(await prisma.storeMembership.count({ where: { userId: { startsWith: 'legacy_' } } })).toBe(2);
      await prisma.user.deleteMany({ where: { id: { startsWith: 'legacy_' } } });
    });

    it('seeds Manager with exactly the legacy ADMIN access and Owner with every permission', async () => {
      const roles = await prisma.staffRole.findMany({ where: { isSystem: true } });
      const byKey = Object.fromEntries(roles.map((role) => [role.key, role]));

      expect(Object.keys(byKey).sort()).toEqual(['CASHIER', 'INVENTORY_CLERK', 'MANAGER', 'OWNER', 'SUPPORT']);
      expect([...byKey.MANAGER.permissions].sort()).toEqual([...MANAGER_PERMISSIONS].sort());
      expect([...byKey.OWNER.permissions].sort()).toEqual([...ALL_PERMISSIONS].sort());
      expect(byKey.OWNER.mfaRequired && byKey.MANAGER.mfaRequired).toBe(true);
    });
  });

  describe('role catalogue', () => {
    it('lists roles, permissions and staff to staff.view holders and hides them from customers', async () => {
      const res = await gql(
        '{ staffRoles { key permissions isSystem } staffPermissions { key } staffMembers { user { email } role { key } } }',
        managerToken,
      );
      const denied = await gql('{ staffRoles { key } }', customerToken);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.staffPermissions.map((p: { key: string }) => p.key)).toEqual(ALL_PERMISSIONS);
      expect(res.body.data.staffMembers).toEqual(
        expect.arrayContaining([
          { user: { email: 'super_admin@example.com' }, role: { key: 'OWNER' } },
          { user: { email: 'admin@example.com' }, role: { key: 'MANAGER' } },
        ]),
      );
      expect(denied.body.errors[0].extensions.code).toBe('FORBIDDEN');
    });

    it("shows a user's staff role and effective permissions on User", async () => {
      const res = await gql('{ userProfile { role staffRole { key } permissions } }', managerToken);
      const customer = await gql('{ userProfile { role staffRole { key } permissions } }', customerToken);

      expect(res.body.data.userProfile).toEqual({
        role: 'ADMIN',
        staffRole: { key: 'MANAGER' },
        permissions: MANAGER_PERMISSIONS,
      });
      expect(customer.body.data.userProfile).toEqual({ role: 'USER', staffRole: null, permissions: [] });
    });
  });

  describe('assigning roles', () => {
    it('refuses a Manager (no staff.manage), even for a lesser role', async () => {
      const target = await newCustomer('cashier-by-manager@example.com');

      const res = await assign(target.id, 'CASHIER', managerToken);

      expect(res.body.errors[0].extensions.code).toBe('FORBIDDEN');
      expect(await roleOf(target.id)).toBeNull();
    });

    it('lets an Owner assign a role, keeps the legacy role in step and applies it on the next request', async () => {
      const target = await newCustomer('new-cashier@example.com');
      const before = await gql('{ payments { id } }', target.token);

      const res = await assign(target.id, 'CASHIER', ownerToken);
      const after = await gql('{ payments { id } }', target.token);

      expect(before.body.errors[0].extensions.code).toBe('FORBIDDEN');
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.assignStaffRole).toEqual({
        role: { key: 'CASHIER' },
        user: { id: target.id, role: 'ADMIN' },
      });
      expect(after.body.errors).toBeUndefined();
      const audit = await prisma.auditLog.findMany({ where: { entity: 'StoreMembership', entityId: target.id } });
      expect(audit).toEqual([
        expect.objectContaining({
          action: 'ROLE_ASSIGN',
          userId: 'seed_super_admin',
          details: { from: null, to: 'CASHIER' },
        }),
      ]);
    });

    it('stops a staff manager from granting Owner or a role with permissions they lack (no escalation)', async () => {
      const created = await gql(
        `mutation { createStaffRole(input: { key: "STAFF_ADMIN", name: "Staff admin",
          permissions: ["staff.manage", "staff.view", "order.view", "payment.view", "payment.record", "catalog.product.read"] }) { key } }`,
        ownerToken,
      );
      expect(created.body.errors).toBeUndefined();
      const staffAdmin = await newCustomer('staff-admin@example.com');
      await assign(staffAdmin.id, 'STAFF_ADMIN', ownerToken);
      // Role changes are step-up actions, so the staff manager enrols two-factor authentication (a fresh verification).
      const started = await gql('mutation { startMfaEnrollment { secret } }', staffAdmin.token);
      const code = totp(base32Decode(started.body.data.startMfaEnrollment.secret), Date.now());
      await gql(`mutation { confirmMfaEnrollment(code: "${code}") { recoveryCodes } }`, staffAdmin.token);
      const target = await newCustomer('escalation-target@example.com');

      const toOwner = await assign(target.id, 'OWNER', staffAdmin.token);
      const toManager = await assign(target.id, 'MANAGER', staffAdmin.token);
      const toSelfOwner = await assign(staffAdmin.id, 'OWNER', staffAdmin.token);
      const toCashier = await assign(target.id, 'CASHIER', staffAdmin.token);

      expect(toOwner.body.errors[0].message).toBe('Only an Owner can assign the Owner role');
      expect(toManager.body.errors[0].extensions.code).toBe('FORBIDDEN');
      expect(toSelfOwner.body.errors[0].extensions.code).toBe('FORBIDDEN');
      expect(toCashier.body.errors).toBeUndefined();
      expect(await roleOf(target.id)).toBe('CASHIER');
      expect(await roleOf(staffAdmin.id)).toBe('STAFF_ADMIN');
    });

    it('lets an Owner make another Owner, and never lets the last Owner go', async () => {
      const second = await newCustomer('second-owner@example.com');
      expect((await assign(second.id, 'OWNER', ownerToken)).body.errors).toBeUndefined();

      const removed = await gql(`mutation { removeStaffRole(userId: "${second.id}") { id role } }`, ownerToken);
      const removeLast = await gql('mutation { removeStaffRole(userId: "seed_super_admin") { id } }', ownerToken);
      const demoteLast = await assign('seed_super_admin', 'MANAGER', ownerToken);
      const archiveLast = await gql('mutation { archiveUser(id: "seed_super_admin") { id } }', ownerToken);

      expect(removed.body.data.removeStaffRole).toEqual({ id: second.id, role: 'USER' });
      for (const res of [removeLast, demoteLast, archiveLast]) {
        expect(res.body.errors[0]).toMatchObject({
          message: 'The store must keep at least one active Owner',
          extensions: { code: 'FORBIDDEN' },
        });
      }
      expect(await roleOf('seed_super_admin')).toBe('OWNER');
    });

    it('refuses a Manager acting on an Owner account', async () => {
      const res = await gql(
        'mutation { updateUser(id: "seed_super_admin", updateUserInput: { name: "Hijacked" }) { id } }',
        managerToken,
      );

      expect(res.body.errors[0]).toMatchObject({
        message: 'Staff accounts can only be updated by someone with the staff.manage permission',
        extensions: { code: 'FORBIDDEN' },
      });
    });
  });

  describe('custom roles', () => {
    it('validates permissions and keeps system roles immutable', async () => {
      const unknown = await gql(
        'mutation { createStaffRole(input: { key: "BAD_ROLE", name: "Bad", permissions: ["order.steal"] }) { key } }',
        ownerToken,
      );
      const system = await gql(
        'mutation { updateStaffRole(key: "MANAGER", input: { name: "Boss" }) { key } }',
        ownerToken,
      );
      const byManager = await gql(
        'mutation { createStaffRole(input: { key: "MGR_ROLE", name: "Mine", permissions: ["order.view"] }) { key } }',
        managerToken,
      );

      expect(unknown.body.errors[0]).toMatchObject({
        message: 'Unknown permissions: order.steal',
        extensions: { code: 'BAD_REQUEST' },
      });
      expect(system.body.errors[0].message).toBe('System roles cannot be changed');
      expect(byManager.body.errors[0].extensions.code).toBe('FORBIDDEN');
    });

    it('applies a changed custom role to its holders on their next request', async () => {
      await gql(
        'mutation { createStaffRole(input: { key: "VIEWER", name: "Viewer", permissions: ["order.view"] }) { key } }',
        ownerToken,
      );
      const viewer = await newCustomer('viewer@example.com');
      await assign(viewer.id, 'VIEWER', ownerToken);
      const before = await gql('{ payments { id } }', viewer.token);

      const updated = await gql(
        'mutation { updateStaffRole(key: "VIEWER", input: { permissions: ["order.view", "payment.view"] }) { permissions } }',
        ownerToken,
      );
      const after = await gql('{ payments { id } }', viewer.token);

      expect(before.body.errors[0].extensions.code).toBe('FORBIDDEN');
      expect(updated.body.data.updateStaffRole.permissions).toEqual(['order.view', 'payment.view']);
      expect(after.body.errors).toBeUndefined();
    });
  });

  describe('customers', () => {
    it('keep their self-service access and cannot reach staff operations', async () => {
      const own = await gql('{ userProfile { email } getMyPayments { id } }', customerToken);
      const staffOnly = await gql('{ orders { id } }', customerToken);

      expect(own.body.errors).toBeUndefined();
      expect(staffOnly.body.errors[0].extensions.code).toBe('FORBIDDEN');
    });

    it('keep customer-only operations to customers', async () => {
      const res = await gql('{ getMyPayments { id } }', managerToken);

      expect(res.body.errors[0].extensions.code).toBe('FORBIDDEN');
    });
  });
});
