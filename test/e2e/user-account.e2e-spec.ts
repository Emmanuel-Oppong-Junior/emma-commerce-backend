import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInUser, signInAdmin, signInSuperAdmin, signUpUser } from '../helpers/auth.helper';

describe('User Account (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userToken: string;
  let adminToken: string;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    userToken = await signInUser(app);
    adminToken = await signInAdmin(app);
  });

  afterAll(() => app.close());

  // ─── userProfile ──────────────────────────────────────────────────────────────

  describe('userProfile', () => {
    it('returns the authenticated user profile', async () => {
      // Arrange
      const query = `
        query {
          userProfile {
            id
            name
            email
            role
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, query, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.userProfile).toMatchObject({
        email: 'user@example.com',
        role: 'USER',
      });
    });
  });

  // ─── updateMyProfile ──────────────────────────────────────────────────────────

  describe('updateMyProfile', () => {
    it('succeeds with valid input and returns the updated user', async () => {
      // Arrange
      const mutation = `
        mutation {
          updateMyProfile(updateMyProfileInput: { name: "Updated Name" }) {
            id
            name
            email
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, userToken).expect(200);

      // Assert — the DTO transformer lowercases names
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.updateMyProfile.name).toBe('updated name');
      expect(res.body.data.updateMyProfile.email).toBe('user@example.com');
    });
  });

  // ─── changeUserPassword ───────────────────────────────────────────────────────

  describe('changeUserPassword', () => {
    it('succeeds with the correct current password', async () => {
      // Arrange — sign up a throwaway user so the main user's password stays intact
      const { accessToken } = await signUpUser(app, {
        name: 'Pwchange User',
        email: 'pwchange@test.com',
        password: 'OldPass@1',
      });

      const mutation = `
        mutation {
          changeUserPassword(input: { oldPassword: "OldPass@1", newPassword: "NewPass@1" }) {
            id
            email
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, accessToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.changeUserPassword.email).toBe('pwchange@test.com');
    });

    it('fails when the current password is wrong', async () => {
      // Arrange
      const mutation = `
        mutation {
          changeUserPassword(input: { oldPassword: "WrongPass@1", newPassword: "NewPass@1" }) {
            id
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeDefined();
    });
  });

  // ─── createAddress ────────────────────────────────────────────────────────────

  describe('createAddress', () => {
    it('creates and returns a new address for the authenticated user', async () => {
      // Arrange
      const mutation = `
        mutation {
          createAddress(input: {
            street: "123 Main St"
            city: "Accra"
            state: "Greater Accra"
            zipCode: "00233"
            country: "Ghana"
          }) {
            id
            street
            city
            state
            zipCode
            country
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.createAddress).toMatchObject({
        street: '123 Main St',
        city: 'Accra',
        country: 'Ghana',
      });
    });
  });

  // ─── userAddresses ────────────────────────────────────────────────────────────

  describe('userAddresses', () => {
    it("returns only the authenticated user's own addresses", async () => {
      // Arrange — also create an address for the admin to confirm isolation
      const adminAddressMutation = `
        mutation {
          createAddress(input: {
            street: "Admin Street"
            city: "Kumasi"
            state: "Ashanti"
            zipCode: "00100"
            country: "Ghana"
          }) {
            id
          }
        }
      `;
      await gqlRequest(app, adminAddressMutation, undefined, adminToken).expect(200);

      const query = `
        query {
          userAddresses {
            id
            street
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, query, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      const addresses: Array<{ id: string; street: string }> = res.body.data.userAddresses;
      expect(addresses.length).toBeGreaterThanOrEqual(1);
      // None of the returned addresses belong to the admin
      const hasAdminAddress = addresses.some((a) => a.street === 'Admin Street');
      expect(hasAdminAddress).toBe(false);
    });
  });

  // ─── updateAddress ────────────────────────────────────────────────────────────

  describe('updateAddress', () => {
    let userAddressId: string;
    let adminAddressId: string;

    beforeAll(async () => {
      // Fetch the user's existing address
      const userQuery = `
        query {
          userAddresses { id street }
        }
      `;
      const userRes = await gqlRequest(app, userQuery, undefined, userToken).expect(200);
      userAddressId = userRes.body.data.userAddresses[0].id;

      // Fetch the admin's address
      const adminQuery = `
        query {
          userAddresses { id street }
        }
      `;
      const adminRes = await gqlRequest(app, adminQuery, undefined, adminToken).expect(200);
      adminAddressId = adminRes.body.data.userAddresses[0].id;
    });

    it('succeeds when the user updates their own address', async () => {
      // Arrange
      const mutation = `
        mutation {
          updateAddress(
            addressId: "${userAddressId}"
            input: { city: "Tema" }
          ) {
            id
            city
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.updateAddress.city).toBe('Tema');
    });

    it("fails when a user tries to update another user's address", async () => {
      // Arrange — user1 (seed_user) tries to update admin's address
      const mutation = `
        mutation {
          updateAddress(
            addressId: "${adminAddressId}"
            input: { city: "Tamale" }
          ) {
            id
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, userToken).expect(200);

      // Assert — service returns NotFoundException (address not found for this user)
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(/not found/i);
    });
  });

  // ─── deleteAddress ────────────────────────────────────────────────────────────

  describe('deleteAddress', () => {
    it("deletes the user's own address successfully", async () => {
      // Arrange — create a throwaway address to delete
      const createMutation = `
        mutation {
          createAddress(input: {
            street: "Delete Me"
            city: "Accra"
            state: "Greater Accra"
            zipCode: "00233"
            country: "Ghana"
          }) {
            id
          }
        }
      `;
      const createRes = await gqlRequest(app, createMutation, undefined, userToken).expect(200);
      const addressId = createRes.body.data.createAddress.id;

      const mutation = `
        mutation {
          deleteAddress(addressId: "${addressId}") {
            id
            street
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation, undefined, userToken).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.deleteAddress.id).toBe(addressId);

      // Confirm deletion via Prisma (avoids extra GraphQL requests that count against throttle)
      const deleted = await prisma.address.findUnique({ where: { id: addressId } });
      expect(deleted).toBeNull();
    });
  });

  // ─── admin account management ────────────────────────────────────────────────

  describe('admin account management', () => {
    const archive = (id: string) => `mutation { archiveUser(id: "${id}") { id isActive } }`;

    it('rejects an ADMIN archiving a peer ADMIN and lets a SUPER_ADMIN do it', async () => {
      // Arrange
      const peer = await prisma.user.create({
        data: { email: 'peer-admin@example.com', name: 'Peer Admin', role: 'ADMIN' },
      });
      const superAdminToken = await signInSuperAdmin(app);

      // Act
      const byAdmin = await gqlRequest(app, archive(peer.id), undefined, adminToken).expect(200);
      const bySuperAdmin = await gqlRequest(app, archive(peer.id), undefined, superAdminToken).expect(200);

      // Assert
      expect(byAdmin.body.errors[0].extensions.code).toBe('FORBIDDEN');
      expect(bySuperAdmin.body.errors).toBeUndefined();
      expect(bySuperAdmin.body.data.archiveUser).toEqual({ id: peer.id, isActive: false });
    });
  });
});
