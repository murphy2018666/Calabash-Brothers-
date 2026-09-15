import { Module } from '@nestjs/common';
import { SkillService } from './skill.service';
import { SkillReviewService } from './skill-review.service';

/**
 * Skill 子域 NestJS 模块（DES-11）。
 * PolicySimulator 实现由控制面注入（对接 Decision 子域的 simulate）。
 */
@Module({
  providers: [SkillService, SkillReviewService],
  exports: [SkillService, SkillReviewService],
})
export class SkillModule {}
