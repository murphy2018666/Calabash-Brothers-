import { ForecastController } from '../controllers/forecast.controller';
import { ForecastService } from '../services/forecast.service';
import { BillingEngineService } from '../services/billing-engine.service';
import { MeteringService } from '../services/metering.service';
import { CertifiedSkillPricingService } from '../services/certified-skill-pricing.service';

describe('ForecastController', () => {
  let controller: ForecastController;
  let forecastService: ForecastService;

  beforeEach(() => {
    const billing = new BillingEngineService(new MeteringService(), new CertifiedSkillPricingService());
    forecastService = new ForecastService(billing);
    billing.clear();
    controller = new ForecastController(forecastService);
  });

  it('returns forecast result with valid params', () => {
    const result = controller.getRevenueForecast('t1', '3', 'linear');
    expect(result).toBeDefined();
    expect(result.method).toBe('linear');
  });

  it('defaults to linear method when method is absent', () => {
    const result = controller.getRevenueForecast('t1', '3');
    expect(result.method).toBe('linear');
  });

  it('returns exponential forecast when method=exponential', () => {
    const result = controller.getRevenueForecast('t1', '3', 'exponential');
    expect(result.method).toBe('exponential');
  });

  it('throws BadRequestException for invalid months', () => {
    expect(() => controller.getRevenueForecast('t1', '0', 'linear'))
      .toThrow('months must be an integer between 1 and 24');
    expect(() => controller.getRevenueForecast('t1', '25', 'linear'))
      .toThrow('months must be an integer between 1 and 24');
    expect(() => controller.getRevenueForecast('t1', 'abc', 'linear'))
      .toThrow('months must be an integer between 1 and 24');
  });

  it('throws BadRequestException for invalid method', () => {
    expect(() => controller.getRevenueForecast('t1', '3', 'logarithmic'))
      .toThrow('method must be linear or exponential');
  });

  it('returns historical revenue points', () => {
    const result = controller.getHistoricalRevenue('t1', '6');
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  it('throws BadRequestException for invalid historical months', () => {
    expect(() => controller.getHistoricalRevenue('t1', '0'))
      .toThrow('months must be an integer between 1 and 24');
  });
});
