/**
 * Policy Approval 子域入口（DES-5.0）。
 * HITL 审批工单 + quorum 计票 + ApprovalCompleted 事件发布。
 */
export { ApprovalService } from './approval.service';
export type { ApprovalCompletedPayload } from './approval.service';
export {
  ApprovalTicket,
  type ApprovalTicketState,
  type ApprovalVote,
  type ApprovalTicketInit,
} from './approval-ticket.aggregate';
export { ApprovalModule } from './approval.module';
