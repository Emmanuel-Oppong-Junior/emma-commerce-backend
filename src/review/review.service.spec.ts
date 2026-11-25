import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ReviewService } from './review.service';
import { ReviewRepository } from './review.repository';
import { AuditService } from '../commons/audit.service';
import { Review } from '../generated/prisma/client';
import { ReviewSort } from './dto/review-list.args';

describe('ReviewService', () => {
  let service: ReviewService;
  const tx = { tx: true };
  const repo = {
    transaction: jest.fn(),
    isPublicProduct: jest.fn(),
    lockProduct: jest.fn(),
    lockReview: jest.fn(),
    refreshRating: jest.fn(),
    purchasedLines: jest.fn(),
    findOwn: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    findPublished: jest.fn(),
    findByUser: jest.fn(),
    findReported: jest.fn(),
    createReport: jest.fn(),
    findReport: jest.fn(),
    resolveReports: jest.fn(),
    countPhotos: jest.fn(),
    addPhoto: jest.fn(),
    findPhoto: jest.fn(),
    deletePhoto: jest.fn(),
  };
  const audit = { log: jest.fn() };

  const review = (overrides: Partial<Review> = {}): Review => ({
    id: 'rev1',
    userId: 'user1',
    productId: 'prod1',
    score: 5,
    title: null,
    comment: 'Great product!',
    status: 'PUBLISHED',
    verifiedPurchase: true,
    orderItemId: 'item1',
    hiddenReason: null,
    hiddenAt: null,
    reply: null,
    repliedAt: null,
    editedAt: null,
    createdAt: new Date('2026-11-01'),
    updatedAt: new Date('2026-11-01'),
    ...overrides,
  });
  const deliveredLine = {
    orderItemId: 'item1',
    orderStatus: 'COMPLETED',
    orderedAt: new Date('2026-10-01'),
    quantity: 1,
    deliveredUnits: 1,
    refundedUnits: 0,
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    repo.transaction.mockImplementation((work: (client: unknown) => unknown) => work(tx));
    repo.isPublicProduct.mockResolvedValue(true);
    repo.lockProduct.mockResolvedValue(true);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReviewService,
        { provide: ReviewRepository, useValue: repo },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = module.get(ReviewService);
  });

  describe('createReview', () => {
    it('publishes a verified review under the product lock and refreshes the rating', async () => {
      repo.findOwn.mockResolvedValue(null);
      repo.purchasedLines.mockResolvedValue([deliveredLine]);
      repo.create.mockResolvedValue(review());

      await service.createReview('user1', { productId: 'prod1', score: 5, title: '  Solid  ', comment: '   ' });

      expect(repo.lockProduct).toHaveBeenCalledWith(tx, 'prod1');
      expect(repo.create).toHaveBeenCalledWith(tx, {
        userId: 'user1',
        productId: 'prod1',
        score: 5,
        title: 'Solid',
        comment: null,
        verifiedPurchase: true,
        orderItemId: 'item1',
      });
      expect(repo.refreshRating).toHaveBeenCalledWith(tx, 'prod1');
    });

    it('refuses a product that is not public', async () => {
      repo.isPublicProduct.mockResolvedValue(false);

      await expect(service.createReview('user1', { productId: 'prod1', score: 5 })).rejects.toThrow(NotFoundException);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('refuses a second review of the same product', async () => {
      repo.findOwn.mockResolvedValue(review());

      await expect(service.createReview('user1', { productId: 'prod1', score: 3 })).rejects.toMatchObject({
        response: { extensions: { reason: 'REVIEW_ALREADY_EXISTS' } },
      });
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('refuses a customer who never received the product', async () => {
      repo.findOwn.mockResolvedValue(null);
      repo.purchasedLines.mockResolvedValue([{ ...deliveredLine, orderStatus: 'CONFIRMED', deliveredUnits: 0 }]);

      const attempt = service.createReview('user1', { productId: 'prod1', score: 5 });

      await expect(attempt).rejects.toThrow(ForbiddenException);
      await expect(attempt).rejects.toMatchObject({
        response: { extensions: { reason: 'REVIEW_NOT_VERIFIED_PURCHASE' } },
      });
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  describe('getReview', () => {
    it('shows a published review of a public product to anyone', async () => {
      repo.findById.mockResolvedValue(review());

      await expect(service.getReview('rev1', { canModerate: false })).resolves.toMatchObject({ id: 'rev1' });
    });

    it('hides a hidden review from others but shows it to its author and moderators', async () => {
      repo.findById.mockResolvedValue(review({ status: 'HIDDEN' }));

      await expect(service.getReview('rev1', { userId: 'user2', canModerate: false })).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.getReview('rev1', { userId: 'user1', canModerate: false })).resolves.toBeDefined();
      await expect(service.getReview('rev1', { userId: 'staff', canModerate: true })).resolves.toBeDefined();
    });

    it('hides reviews of products that are not public', async () => {
      repo.findById.mockResolvedValue(review());
      repo.isPublicProduct.mockResolvedValue(false);

      await expect(service.getReview('rev1', { canModerate: false })).rejects.toThrow(NotFoundException);
    });

    it('fails for an unknown review', async () => {
      repo.findById.mockResolvedValue(null);

      await expect(service.getReview('nope', { canModerate: true })).rejects.toThrow(NotFoundException);
    });
  });

  describe('lists', () => {
    it('pages through the published reviews of a public product', async () => {
      repo.findPublished.mockResolvedValue([review()]);

      await service.getProductReviews({ productId: 'prod1', sort: ReviewSort.HIGHEST, first: 10, after: 'rev0' });

      expect(repo.findPublished).toHaveBeenCalledWith('prod1', ReviewSort.HIGHEST, 10, 'rev0');
    });

    it('refuses the reviews of a product that is not public', async () => {
      repo.isPublicProduct.mockResolvedValue(false);

      await expect(
        service.getProductReviews({ productId: 'prod1', sort: ReviewSort.NEWEST, first: 10 }),
      ).rejects.toThrow(NotFoundException);
    });

    it("lists the caller's own reviews", async () => {
      repo.findByUser.mockResolvedValue([]);

      await expect(service.getUserReviews('user1', { first: 5 })).resolves.toEqual([]);
      expect(repo.findByUser).toHaveBeenCalledWith('user1', 5, undefined);
    });
  });

  describe('updateReview', () => {
    it('clears the comment when it is sent as null and keeps omitted fields', async () => {
      repo.findById.mockResolvedValue(review());
      repo.update.mockResolvedValue(review({ comment: null }));

      await service.updateReview('user1', { id: 'rev1', comment: null });

      expect(repo.update).toHaveBeenCalledWith(tx, 'rev1', { comment: null, editedAt: expect.any(Date) });
      expect(repo.refreshRating).toHaveBeenCalledWith(tx, 'prod1');
    });

    it('changes the score and title', async () => {
      repo.findById.mockResolvedValue(review());
      repo.update.mockResolvedValue(review({ score: 2 }));

      await service.updateReview('user1', { id: 'rev1', score: 2, title: ' Meh ' });

      expect(repo.update).toHaveBeenCalledWith(tx, 'rev1', { score: 2, title: 'Meh', editedAt: expect.any(Date) });
    });

    it("refuses another customer's review", async () => {
      repo.findById.mockResolvedValue(review());

      await expect(service.updateReview('user2', { id: 'rev1', score: 1 })).rejects.toThrow(/your own/);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('fails for an unknown review', async () => {
      repo.findById.mockResolvedValue(null);

      await expect(service.updateReview('user1', { id: 'nope', score: 1 })).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteReview', () => {
    it('deletes the own review and refreshes the rating', async () => {
      repo.findById.mockResolvedValue(review());
      repo.delete.mockResolvedValue(review());

      await expect(service.deleteReview('user1', 'rev1')).resolves.toMatchObject({ id: 'rev1' });
      expect(repo.delete).toHaveBeenCalledWith(tx, 'rev1');
      expect(repo.refreshRating).toHaveBeenCalledWith(tx, 'prod1');
    });

    it("refuses another customer's review", async () => {
      repo.findById.mockResolvedValue(review());

      await expect(service.deleteReview('user2', 'rev1')).rejects.toThrow(ForbiddenException);
      expect(repo.delete).not.toHaveBeenCalled();
    });

    it('fails for an unknown review', async () => {
      repo.findById.mockResolvedValue(null);

      await expect(service.deleteReview('user1', 'nope')).rejects.toThrow(NotFoundException);
    });
  });

  describe('reportReview', () => {
    beforeEach(() => repo.findById.mockResolvedValue(review()));

    it('records one report per customer', async () => {
      repo.findReport.mockResolvedValue(null);

      await expect(service.reportReview('user2', { id: 'rev1', reason: 'SPAM', note: '  ads ' })).resolves.toBe(true);
      expect(repo.createReport).toHaveBeenCalledWith(tx, {
        reviewId: 'rev1',
        reporterId: 'user2',
        reason: 'SPAM',
        note: 'ads',
      });
    });

    it('refuses a second report by the same customer', async () => {
      repo.findReport.mockResolvedValue({ id: 'report1' });

      await expect(service.reportReview('user2', { id: 'rev1', reason: 'SPAM' })).rejects.toThrow(ConflictException);
    });

    it('refuses reporting your own review and OTHER without a note', async () => {
      await expect(service.reportReview('user1', { id: 'rev1', reason: 'SPAM' })).rejects.toThrow(BadRequestException);
      await expect(service.reportReview('user2', { id: 'rev1', reason: 'OTHER', note: ' ' })).rejects.toThrow(
        /note is required/,
      );
      expect(repo.createReport).not.toHaveBeenCalled();
    });

    it('refuses reporting a hidden review', async () => {
      repo.findById.mockResolvedValue(review({ status: 'HIDDEN' }));

      await expect(service.reportReview('user2', { id: 'rev1', reason: 'SPAM' })).rejects.toThrow(NotFoundException);
    });
  });

  describe('moderation audit trail', () => {
    it('hides a review, closes its reports, refreshes the rating and audits in the same transaction', async () => {
      repo.findById.mockResolvedValue(review());
      repo.update.mockResolvedValue(review({ status: 'HIDDEN' }));
      repo.resolveReports.mockResolvedValue(2);

      await service.hideReview('staff1', { id: 'rev1', reason: 'Abusive' });

      expect(repo.lockProduct).toHaveBeenCalledWith(tx, 'prod1');
      expect(repo.update).toHaveBeenCalledWith(tx, 'rev1', {
        status: 'HIDDEN',
        hiddenAt: expect.any(Date),
        hiddenReason: 'Abusive',
      });
      expect(repo.resolveReports).toHaveBeenCalledWith(tx, 'rev1', expect.any(Date));
      expect(repo.refreshRating).toHaveBeenCalledWith(tx, 'prod1');
      expect(audit.log).toHaveBeenCalledWith(
        {
          entity: 'Review',
          entityId: 'rev1',
          action: 'STATUS_CHANGE',
          userId: 'staff1',
          details: { from: 'PUBLISHED', to: 'HIDDEN', reason: 'Abusive', resolvedReports: 2 },
        },
        tx,
      );
    });

    it('unhides a hidden review and audits it', async () => {
      repo.findById.mockResolvedValue(review({ status: 'HIDDEN', hiddenAt: new Date(), hiddenReason: 'x' }));
      repo.update.mockResolvedValue(review());

      await service.unhideReview('staff1', { id: 'rev1', reason: 'Appeal upheld' });

      expect(repo.update).toHaveBeenCalledWith(tx, 'rev1', {
        status: 'PUBLISHED',
        hiddenAt: null,
        hiddenReason: null,
      });
      expect(repo.resolveReports).not.toHaveBeenCalled();
      expect(repo.refreshRating).toHaveBeenCalledWith(tx, 'prod1');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'STATUS_CHANGE', details: expect.objectContaining({ to: 'PUBLISHED' }) }),
        tx,
      );
    });

    it('refuses hiding a hidden review', async () => {
      repo.findById.mockResolvedValue(review({ status: 'HIDDEN' }));

      await expect(service.hideReview('staff1', { id: 'rev1', reason: 'Again' })).rejects.toThrow(ConflictException);
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('dismisses open reports with an audit row', async () => {
      repo.findById.mockResolvedValue(review());
      repo.resolveReports.mockResolvedValue(1);

      await service.dismissReviewReports('staff1', { id: 'rev1', reason: 'Fair review' });

      expect(audit.log).toHaveBeenCalledWith(
        {
          entity: 'Review',
          entityId: 'rev1',
          action: 'UPDATE',
          userId: 'staff1',
          details: { dismissedReports: 1, reason: 'Fair review' },
        },
        tx,
      );
    });

    it('replies to a review with an audit row', async () => {
      repo.findById.mockResolvedValue(review());
      repo.update.mockResolvedValue(review({ reply: 'Thanks', repliedAt: new Date() }));

      await service.replyToReview('staff1', { reviewId: 'rev1', body: 'Thanks' });

      expect(repo.update).toHaveBeenCalledWith(tx, 'rev1', { reply: 'Thanks', repliedAt: expect.any(Date) });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'UPDATE', details: { reply: { from: null, to: 'Thanks' } } }),
        tx,
      );
    });
  });

  describe('photos', () => {
    it('adds a photo under the review lock while there is room', async () => {
      repo.findById.mockResolvedValue(review());
      repo.countPhotos.mockResolvedValue(3);
      repo.addPhoto.mockResolvedValue({ id: 'photo1' });

      await service.attachPhoto('user1', 'rev1', { publicId: 'reviews/rev1/a', url: 'https://x.test/a.png' });

      expect(repo.lockReview).toHaveBeenCalledWith(tx, 'rev1');
      expect(repo.addPhoto).toHaveBeenCalledWith(tx, {
        reviewId: 'rev1',
        publicId: 'reviews/rev1/a',
        url: 'https://x.test/a.png',
      });
    });

    it('refuses a fifth photo', async () => {
      repo.findById.mockResolvedValue(review());
      repo.countPhotos.mockResolvedValue(4);

      await expect(service.assertCanAddPhoto('user1', 'rev1')).rejects.toMatchObject({
        response: { extensions: { reason: 'REVIEW_PHOTO_LIMIT' } },
      });
    });

    it("refuses photos on another customer's review and removing their photos", async () => {
      repo.findById.mockResolvedValue(review());
      repo.findPhoto.mockResolvedValue({ id: 'photo1', review: review() });

      await expect(service.assertCanAddPhoto('user2', 'rev1')).rejects.toThrow(ForbiddenException);
      await expect(service.removePhoto('user2', 'photo1')).rejects.toThrow(NotFoundException);
      await expect(service.removePhoto('user1', 'photo1')).resolves.toBe(true);
      expect(repo.deletePhoto).toHaveBeenCalledWith('photo1');
    });
  });
});
