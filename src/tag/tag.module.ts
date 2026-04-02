import { Module } from '@nestjs/common';
import { TagService } from './tag.service';
import { TagResolver } from './tag.resolver';
import { TagRepository } from './tag.repository';

@Module({
  providers: [TagResolver, TagService, TagRepository],
  exports: [TagService],
})
export class TagModule {}
