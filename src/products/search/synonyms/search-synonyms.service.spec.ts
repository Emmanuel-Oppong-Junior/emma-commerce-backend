import { BadRequestException, NotFoundException } from '@nestjs/common';
import { SearchSynonymsService } from './search-synonyms.service';
import { SearchSynonymsRepository } from './search-synonyms.repository';
import { AUDIT_TX, createAuditServiceMock } from '../../../../test/helpers/audit.helper';
import { AuditService } from '../../../commons/audit.service';
import { MAX_SYNONYM_GROUPS } from './synonym-rules';

const saved = {
  id: 'syn1',
  kind: 'TWO_WAY' as const,
  term: null,
  synonyms: ['phone', 'mobile'],
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('SearchSynonymsService', () => {
  const repository = {
    findAll: jest.fn(),
    findById: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };
  const audit = createAuditServiceMock();
  const service = new SearchSynonymsService(
    repository as unknown as SearchSynonymsRepository,
    audit as unknown as AuditService,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    repository.count.mockResolvedValue(0);
    repository.findById.mockResolvedValue(saved);
  });

  it('stores the terms normalised, in the audited transaction', async () => {
    repository.create.mockResolvedValue(saved);

    await service.create({ kind: 'TWO_WAY', synonyms: ['  Phone ', 'MOBILE'] }, 'staff1');

    expect(repository.create).toHaveBeenCalledWith(AUDIT_TX, {
      kind: 'TWO_WAY',
      term: null,
      synonyms: ['phone', 'mobile'],
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'SearchSynonym', entityId: 'syn1', action: 'CREATE', userId: 'staff1' }),
      AUDIT_TX,
    );
  });

  it('refuses an invalid group before writing', async () => {
    await expect(service.create({ kind: 'ONE_WAY', synonyms: ['mobile'] }, 'staff1')).rejects.toThrow(
      BadRequestException,
    );
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('refuses a group past the cap', async () => {
    repository.count.mockResolvedValue(MAX_SYNONYM_GROUPS);

    await expect(service.create({ kind: 'TWO_WAY', synonyms: ['a1', 'b1'] }, 'staff1')).rejects.toThrow(
      `At most ${MAX_SYNONYM_GROUPS} synonym groups`,
    );
  });

  it('audits an update with the group before and after', async () => {
    repository.update.mockResolvedValue({ ...saved, kind: 'ONE_WAY', term: 'tv', synonyms: ['television'] });

    await service.update('syn1', { kind: 'ONE_WAY', term: 'TV', synonyms: ['Television'] }, 'staff1');

    expect(repository.update).toHaveBeenCalledWith(AUDIT_TX, 'syn1', {
      kind: 'ONE_WAY',
      term: 'tv',
      synonyms: ['television'],
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'UPDATE',
        details: {
          before: { kind: 'TWO_WAY', term: null, synonyms: ['phone', 'mobile'] },
          after: { kind: 'ONE_WAY', term: 'tv', synonyms: ['television'] },
        },
      }),
      AUDIT_TX,
    );
  });

  it('reports an unknown group as not found', async () => {
    repository.findById.mockResolvedValue(null);

    await expect(service.remove('nope', 'staff1')).rejects.toThrow(NotFoundException);
    expect(repository.delete).not.toHaveBeenCalled();
  });
});
