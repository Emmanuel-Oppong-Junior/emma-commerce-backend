import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PathRedirect } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService, fieldValues } from '../../commons/audit.service';
import { internalPathProblem, normalisePath } from '../links';
import { chainStatus, MAX_REDIRECT_HOPS, redirectKey, wouldLoop } from './path-redirect-rules';
import { CreatePathRedirectInput, PathResolution } from './path-redirect.entities';

// Path redirects are written one at a time (this lock, in the write transaction), so two concurrent writes cannot
// each pass the loop check and close a loop together.
const PATH_REDIRECT_LOCK = 70_812_001;
const AUDITED_FIELDS = ['fromPath', 'toPath', 'statusCode'] as const satisfies readonly (keyof PathRedirect)[];

@Injectable()
export class PathRedirectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  findAll(): Promise<PathRedirect[]> {
    return this.prisma.pathRedirect.findMany({ orderBy: { fromPath: 'asc' } });
  }

  /**
   * Refuses a path that is not internal (BAD_REQUEST), a fromPath that already redirects and a redirect that would
   * close a loop (CONFLICT).
   */
  async create(input: CreatePathRedirectInput, actorId: string): Promise<PathRedirect> {
    const fromProblem = internalPathProblem(input.fromPath, false);
    if (fromProblem) throw new BadRequestException(`fromPath: ${fromProblem}`);
    const toProblem = internalPathProblem(input.toPath);
    if (toProblem) throw new BadRequestException(`toPath: ${toProblem}`);
    const fromPath = normalisePath(input.fromPath);
    const toPath = normalisePath(input.toPath);
    return this.audit.record(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PATH_REDIRECT_LOCK})`;
        if (await tx.pathRedirect.findUnique({ where: { fromPath } })) {
          throw new ConflictException(`"${fromPath}" already redirects; delete that redirect first`);
        }
        const existing = await tx.pathRedirect.findMany({ select: { fromPath: true, toPath: true } });
        const targets = new Map(existing.map((redirect) => [redirect.fromPath, redirect.toPath]));
        if (wouldLoop(fromPath, toPath, targets)) {
          throw new ConflictException({
            message: `Redirecting "${fromPath}" to "${toPath}" would make a loop`,
            extensions: { reason: 'REDIRECT_LOOP' },
          });
        }
        return tx.pathRedirect.create({ data: { fromPath, toPath, statusCode: input.statusCode ?? 301 } });
      },
      (created) => ({
        entity: 'PathRedirect',
        entityId: created.id,
        action: 'CREATE',
        userId: actorId,
        details: { after: fieldValues(created, AUDITED_FIELDS) },
      }),
    );
  }

  async remove(id: string, actorId: string): Promise<PathRedirect> {
    const existing = await this.prisma.pathRedirect.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Path redirect "${id}" not found`);
    return this.audit.record(
      (tx) => tx.pathRedirect.delete({ where: { id } }),
      (deleted) => ({
        entity: 'PathRedirect',
        entityId: id,
        action: 'DELETE',
        userId: actorId,
        details: { before: fieldValues(deleted, AUDITED_FIELDS) },
      }),
    );
  }

  /** Where `path` ends up after following the redirects from it (at most 10), or null when none starts there. */
  async resolve(path: string): Promise<PathResolution | null> {
    if (internalPathProblem(path)) return null;
    const statusCodes: number[] = [];
    let toPath: string | null = null;
    let key = redirectKey(path);
    for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
      const redirect = await this.prisma.pathRedirect.findUnique({ where: { fromPath: key } });
      if (!redirect) break;
      statusCodes.push(redirect.statusCode);
      toPath = redirect.toPath;
      key = redirectKey(redirect.toPath);
    }
    return toPath === null ? null : { toPath, statusCode: chainStatus(statusCodes) };
  }
}
