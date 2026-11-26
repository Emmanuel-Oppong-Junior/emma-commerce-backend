import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ProductQuestion } from '../generated/prisma/client';
import { AuditService } from '../commons/audit.service';
import { ProductQuestionsRepository } from './product-questions.repository';
import { ProductQuestionsService } from './product-questions.service';
import { StoreFeaturesService } from '../store-features/store-features.service';
import { featureDisabled } from '../store-features/require-feature';

describe('ProductQuestionsService', () => {
  let service: ProductQuestionsService;
  const tx = { tx: true };
  const repo = {
    transaction: jest.fn(),
    isPublicProduct: jest.fn(),
    create: jest.fn(),
    findById: jest.fn(),
    lock: jest.fn(),
    update: jest.fn(),
    isPublic: jest.fn(),
    findPublic: jest.fn(),
    findByUser: jest.fn(),
    findUnanswered: jest.fn(),
    findReported: jest.fn(),
    findReport: jest.fn(),
    createReport: jest.fn(),
    resolveReports: jest.fn(),
  };
  const audit = { log: jest.fn() };
  const features = { assertEnabled: jest.fn() };

  const question = (overrides: Partial<ProductQuestion> = {}): ProductQuestion => ({
    id: 'q1',
    productId: 'prod1',
    userId: 'asker',
    body: 'Does it come with a charger?',
    answer: 'Yes, a 65 W charger.',
    answeredAt: new Date('2026-11-02'),
    status: 'PUBLISHED',
    hiddenReason: null,
    hiddenAt: null,
    createdAt: new Date('2026-11-01'),
    updatedAt: new Date('2026-11-02'),
    ...overrides,
  });

  beforeEach(async () => {
    jest.resetAllMocks();
    repo.transaction.mockImplementation((work: (client: unknown) => unknown) => work(tx));
    repo.isPublicProduct.mockResolvedValue(true);
    repo.isPublic.mockImplementation((q: ProductQuestion) => q.status === 'PUBLISHED' && q.answeredAt !== null);
    const module = await Test.createTestingModule({
      providers: [
        ProductQuestionsService,
        { provide: ProductQuestionsRepository, useValue: repo },
        { provide: AuditService, useValue: audit },
        { provide: StoreFeaturesService, useValue: features },
      ],
    }).compile();
    service = module.get(ProductQuestionsService);
  });

  it('refuses asking and reporting while product Q&A is switched off (P8-F)', async () => {
    features.assertEnabled.mockRejectedValue(featureDisabled('PRODUCT_QA'));

    await expect(service.ask('asker', { productId: 'prod1', body: 'Does it fit?' })).rejects.toMatchObject({
      response: { extensions: { reason: 'FEATURE_DISABLED', feature: 'PRODUCT_QA' } },
    });
    await expect(service.report('u2', { id: 'q1', reason: 'SPAM' } as never)).rejects.toThrow(BadRequestException);
    expect(features.assertEnabled).toHaveBeenCalledWith('PRODUCT_QA');
    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.createReport).not.toHaveBeenCalled();
  });

  it('asks a question about a public product only', async () => {
    repo.create.mockResolvedValue(question({ answer: null, answeredAt: null }));

    await service.ask('asker', { productId: 'prod1', body: 'Does it come with a charger?' });
    expect(repo.create).toHaveBeenCalledWith({
      productId: 'prod1',
      userId: 'asker',
      body: 'Does it come with a charger?',
    });

    repo.isPublicProduct.mockResolvedValue(false);
    await expect(service.ask('asker', { productId: 'draft', body: 'Is it out yet?' })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('shows an unanswered or hidden question only to its asker and moderators', async () => {
    repo.findById.mockResolvedValue(question({ answer: null, answeredAt: null }));

    await expect(service.getQuestion('q1', { userId: 'other', canModerate: false })).rejects.toThrow(NotFoundException);
    await expect(service.getQuestion('q1', { userId: 'asker', canModerate: false })).resolves.toBeDefined();
    await expect(service.getQuestion('q1', { canModerate: true })).resolves.toBeDefined();

    repo.findById.mockResolvedValue(question({ status: 'HIDDEN' }));
    await expect(service.getQuestion('q1', { canModerate: false })).rejects.toThrow(NotFoundException);
    repo.findById.mockResolvedValue(question());
    await expect(service.getQuestion('q1', { canModerate: false })).resolves.toMatchObject({ id: 'q1' });
  });

  it('answers under the row lock with an audit row', async () => {
    repo.lock.mockResolvedValue(question({ answer: null, answeredAt: null }));
    repo.update.mockResolvedValue(question());

    await service.answer('staff', { questionId: 'q1', answer: 'Yes, a 65 W charger.' });

    expect(repo.update).toHaveBeenCalledWith(tx, 'q1', {
      answer: 'Yes, a 65 W charger.',
      answeredAt: expect.any(Date),
    });
    expect(audit.log).toHaveBeenCalledWith(
      {
        entity: 'ProductQuestion',
        entityId: 'q1',
        action: 'UPDATE',
        userId: 'staff',
        details: { answer: { from: null, to: 'Yes, a 65 W charger.' } },
      },
      tx,
    );
  });

  it('reports a public question once, never your own, and OTHER needs a note', async () => {
    repo.findById.mockResolvedValue(question());
    repo.findReport.mockResolvedValue(null);

    await expect(service.report('reader', { id: 'q1', reason: 'SPAM' })).resolves.toBe(true);
    expect(repo.createReport).toHaveBeenCalledWith({
      questionId: 'q1',
      reporterId: 'reader',
      reason: 'SPAM',
      note: null,
    });
    await expect(service.report('asker', { id: 'q1', reason: 'SPAM' })).rejects.toThrow(BadRequestException);
    await expect(service.report('reader', { id: 'q1', reason: 'OTHER' })).rejects.toThrow(/note is required/);
    repo.findReport.mockResolvedValue({ id: 'r1' });
    await expect(service.report('reader', { id: 'q1', reason: 'SPAM' })).rejects.toThrow(ConflictException);
  });

  it('hides and unhides with audit rows, closing open reports on hide', async () => {
    repo.lock.mockResolvedValue(question());
    repo.update.mockResolvedValue(question({ status: 'HIDDEN' }));
    repo.resolveReports.mockResolvedValue(1);

    await service.hide('staff', { id: 'q1', reason: 'Spam link' });

    expect(repo.update).toHaveBeenCalledWith(tx, 'q1', {
      status: 'HIDDEN',
      hiddenAt: expect.any(Date),
      hiddenReason: 'Spam link',
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'STATUS_CHANGE',
        details: { from: 'PUBLISHED', to: 'HIDDEN', reason: 'Spam link', resolvedReports: 1 },
      }),
      tx,
    );

    repo.lock.mockResolvedValue(question({ status: 'HIDDEN' }));
    await expect(service.hide('staff', { id: 'q1', reason: 'again' })).rejects.toThrow(ConflictException);
    repo.update.mockResolvedValue(question());
    await service.unhide('staff', { id: 'q1', reason: 'Mistake' });
    expect(repo.update).toHaveBeenLastCalledWith(tx, 'q1', { status: 'PUBLISHED', hiddenAt: null, hiddenReason: null });
  });

  it('dismisses reports with an audit row', async () => {
    repo.lock.mockResolvedValue(question());
    repo.resolveReports.mockResolvedValue(2);

    await service.dismissReports('staff', { id: 'q1', reason: 'Fine' });

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'UPDATE', details: { dismissedReports: 2, reason: 'Fine' } }),
      tx,
    );
  });

  it('fails for an unknown question', async () => {
    repo.lock.mockResolvedValue(null);

    await expect(service.answer('staff', { questionId: 'nope', answer: 'x' })).rejects.toThrow(NotFoundException);
    await expect(service.hide('staff', { id: 'nope', reason: 'x' })).rejects.toThrow(NotFoundException);
  });
});
