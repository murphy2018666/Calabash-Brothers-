import { Controller, Get, Post, Param, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { CertificationEngineService } from '../services/certification-engine.service';
import { CertificationMarkService } from '../services/certification-mark.service';
import { RefundService } from '../services/refund-service';
import {
  CertificationQuery,
  RefundQuery,
} from '@aegisci/shared/types';

/**
 * 认证 + 退款合一控制器（K12）。
 *
 * 端点：
 *   POST   /api/certifications/apply         — 申请认证
 *   POST   /api/certifications/:id/review    — 审核认证
 *   POST   /api/certifications/:id/suspend   — 暂停认证
 *   POST   /api/certifications/:id/resume    — 恢复认证
 *   GET    /api/certifications               — 分页查询
 *   GET    /api/certifications/:id           — 详情
 *   GET    /api/certifications/:id/mark      — 获取认证标识
 *   POST   /api/refunds                      — 申请退款
 *   POST   /api/refunds/:id/approve          — 审批退款
 *   POST   /api/refunds/:id/process          — 执行退款
 *   POST   /api/refunds/:id/cancel           — 取消退款
 *   POST   /api/refunds/:id/dispute          — 标记争议
 *   GET    /api/refunds                      — 分页查询
 *   GET    /api/refunds/:id                  — 详情
 *   GET    /api/refunds/check-7days/:billCreatedAt — 7 天检测
 */
@Controller('api')
export class CertificationController {
  constructor(
    private readonly certificationEngine: CertificationEngineService,
    private readonly certificationMark: CertificationMarkService,
    private readonly refundService: RefundService,
  ) {}

  // ── 认证 ──

  @Post('certifications/apply')
  applyCertification(@Query('skillId') skillId: string, @Query('tenantId') tenantId: string) {
    return this.certificationEngine.applyCertification(skillId, tenantId);
  }

  @Post('certifications/:id/review')
  reviewCertification(
    @Param('id') certificationId: string,
    @Query('approved') approved: string,
    @Query('reviewerId') reviewerId: string,
    @Query('note') note?: string,
  ) {
    return this.certificationEngine.reviewCertification(certificationId, approved === 'true', reviewerId, note);
  }

  @Post('certifications/:id/suspend')
  suspendCertification(@Param('id') certificationId: string, @Query('reason') reason?: string) {
    return this.certificationEngine.suspendCertification(certificationId, reason);
  }

  @Post('certifications/:id/resume')
  resumeCertification(@Param('id') certificationId: string) {
    return this.certificationEngine.resumeCertification(certificationId);
  }

  @Get('certifications')
  listCertifications(@Query() query: CertificationQuery) {
    return this.certificationEngine.listCertifications(query);
  }

  @Get('certifications/:id')
  getCertification(@Param('id') certificationId: string, @Query('tenantId') tenantId?: string) {
    return this.certificationEngine.getCertification(certificationId, tenantId);
  }

  @Get('certifications/:id/mark')
  getCertifiedMark(@Param('id') certificationId: string) {
    const cert = this.certificationEngine.getCertification(certificationId);
    if (!cert.certifiedAt) {
      throw new Error('Certification not yet approved');
    }
    const mark = this.certificationMark.generateCertifiedMark(cert.skillId, cert.certifiedAt);
    return { certificationId: cert.certificationId, skillId: cert.skillId, mark };
  }

  // ── 退款 ──

  @Post('refunds')
  requestRefund(
    @Query('billId') billId: string,
    @Query('tenantId') tenantId: string,
    @Query('skillId') skillId: string,
    @Query('amount') amount: string,
    @Query('reason') reason: string,
  ) {
    return this.refundService.requestRefund(billId, tenantId, skillId, parseFloat(amount), reason);
  }

  @Post('refunds/:id/approve')
  approveRefund(@Param('id') refundId: string) {
    return this.refundService.approveRefund(refundId);
  }

  @Post('refunds/:id/process')
  processRefund(@Param('id') refundId: string) {
    return this.refundService.processRefund(refundId);
  }

  @Post('refunds/:id/cancel')
  cancelRefund(@Param('id') refundId: string) {
    return this.refundService.cancelRefund(refundId);
  }

  @Post('refunds/:id/dispute')
  disputeRefund(@Param('id') refundId: string) {
    return this.refundService.disputeRefund(refundId);
  }

  @Get('refunds')
  listRefunds(@Query() query: RefundQuery) {
    return this.refundService.listRefunds(query);
  }

  @Get('refunds/:id')
  getRefund(@Param('id') refundId: string, @Query('tenantId') tenantId?: string) {
    return this.refundService.getRefund(refundId, tenantId);
  }

  @Get('refunds/check-7days/:billCreatedAt')
  check7Days(@Param('billCreatedAt') billCreatedAt: string) {
    return { withinWindow: this.refundService.isWithin7Days(billCreatedAt) };
  }
}
