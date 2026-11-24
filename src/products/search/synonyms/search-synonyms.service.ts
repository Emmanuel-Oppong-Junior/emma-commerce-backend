import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SearchSynonym } from '../../../generated/prisma/client';
import { AuditService } from '../../../commons/audit.service';
import { SearchSynonymsRepository } from './search-synonyms.repository';
import { SearchSynonymInput } from './search-synonym.entity';
import { MAX_SYNONYM_GROUPS, normaliseTerm, SynonymGroup, synonymGroupProblem } from './synonym-rules';

const auditImage = ({ kind, term, synonyms }: SearchSynonym) => ({ kind, term, synonyms });

/**
 * Staff-managed synonym groups. Not cached: the search reads the (small, capped) table on each text search, so every
 * API instance applies a change at once.
 */
@Injectable()
export class SearchSynonymsService {
  constructor(
    private readonly repository: SearchSynonymsRepository,
    private readonly audit: AuditService,
  ) {}

  findAll(): Promise<SearchSynonym[]> {
    return this.repository.findAll();
  }

  async create(input: SearchSynonymInput, actorId: string): Promise<SearchSynonym> {
    const group = this.checked(input);
    const existing = await this.repository.count();
    if (existing >= MAX_SYNONYM_GROUPS) {
      throw new BadRequestException(`At most ${MAX_SYNONYM_GROUPS} synonym groups; remove one first`);
    }
    return this.audit.record(
      (tx) => this.repository.create(tx, { kind: group.kind, term: group.term, synonyms: [...group.synonyms] }),
      (created) => ({
        entity: 'SearchSynonym',
        entityId: created.id,
        action: 'CREATE',
        userId: actorId,
        details: { after: auditImage(created) },
      }),
    );
  }

  async update(id: string, input: SearchSynonymInput, actorId: string): Promise<SearchSynonym> {
    const before = await this.found(id);
    const group = this.checked(input);
    return this.audit.record(
      (tx) => this.repository.update(tx, id, { kind: group.kind, term: group.term, synonyms: [...group.synonyms] }),
      (updated) => ({
        entity: 'SearchSynonym',
        entityId: id,
        action: 'UPDATE',
        userId: actorId,
        details: { before: auditImage(before), after: auditImage(updated) },
      }),
    );
  }

  async remove(id: string, actorId: string): Promise<SearchSynonym> {
    await this.found(id);
    return this.audit.record(
      (tx) => this.repository.delete(tx, id),
      (deleted) => ({
        entity: 'SearchSynonym',
        entityId: id,
        action: 'DELETE',
        userId: actorId,
        details: { before: auditImage(deleted) },
      }),
    );
  }

  private checked(input: SearchSynonymInput): SynonymGroup {
    const group: SynonymGroup = {
      kind: input.kind,
      term: input.term == null ? null : normaliseTerm(input.term),
      synonyms: input.synonyms.map(normaliseTerm),
    };
    const problem = synonymGroupProblem(group);
    if (problem) throw new BadRequestException(problem);
    return group;
  }

  private async found(id: string): Promise<SearchSynonym> {
    const synonym = await this.repository.findById(id);
    if (!synonym) throw new NotFoundException(`Search synonym "${id}" not found`);
    return synonym;
  }
}
