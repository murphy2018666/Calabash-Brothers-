export interface BillingConsistencyReport {
  tenantId: string;
  period: string;
  meteringCount: number;
  billCallCount: number;
  costMatch: boolean;
  settlementMatch: boolean;
  splitMatch: boolean;
  discrepancies: DiscrepancyItem[];
  checkedAt: string;
}

export interface DiscrepancyItem {
  type: 'metering_mismatch' | 'cost_mismatch' | 'settlement_mismatch' | 'split_mismatch';
  expected: number;
  actual: number;
  description: string;
}
