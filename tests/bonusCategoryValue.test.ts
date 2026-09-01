import { describe, it, expect } from 'vitest';
import {
  MULTIPLIER_CURRENCY_TO_POINTS_CURRENCY_ID,
  perDollarValue,
  fmtPerDollarValue,
} from '../src/lib/format';
import { GENERATED_POINTS_CURRENCIES, GENERATED_BENEFITS } from '../electron/benefitsSeedData';

/**
 * Regression coverage for the Bonus Categories per-dollar value ranking
 * (added after Ann's real-money worked example: 7x Hilton Honors points on
 * airfare at ¢0.5/point = 3.5¢ back per dollar spent).
 */
describe('perDollarValue', () => {
  it('matches the worked example: 7x Hilton Honors points at ¢0.5/point = 3.5¢ per $1', () => {
    const hiltonCentsPerPoint = GENERATED_POINTS_CURRENCIES.find(c => c.id === 'hilton_honors_points')!.value_cents_per_point;
    expect(hiltonCentsPerPoint).toBe(0.5);
    const value = perDollarValue(7, hiltonCentsPerPoint);
    expect(value).toBeCloseTo(0.035, 6); // $0.035 = 3.5 cents back per dollar
    expect(fmtPerDollarValue(value)).toBe('3.5¢ back per $1');
  });

  it('ranks a lower points multiplier on a more valuable currency above a higher multiplier on a cheaper one', () => {
    // 3x Delta SkyMiles (¢1.1/pt) = 3.3¢/$1 ... beats 5x IHG points (¢0.5/pt) = 2.5¢/$1
    const delta = perDollarValue(3, 1.1);
    const ihg = perDollarValue(5, 0.5);
    expect(delta).toBeGreaterThan(ihg!);
  });

  it('returns null (not zero) when the multiplier rate is missing', () => {
    expect(perDollarValue(null, 1.7)).toBeNull();
    expect(perDollarValue(undefined, 1.7)).toBeNull();
  });

  it('returns null (not zero) when the currency value is unknown', () => {
    expect(perDollarValue(5, null)).toBeNull();
    expect(perDollarValue(5, undefined)).toBeNull();
  });

  it('fmtPerDollarValue renders a clear placeholder for unknown values instead of $0.00', () => {
    expect(fmtPerDollarValue(null)).toBe('Value unknown');
    expect(fmtPerDollarValue(undefined)).toBe('Value unknown');
  });
});

describe('MULTIPLIER_CURRENCY_TO_POINTS_CURRENCY_ID coverage', () => {
  it('has a mapping entry for every multiplier_currency label used in the seed data', () => {
    const labelsInUse = new Set(
      GENERATED_BENEFITS
        .filter(b => b.category === 'earning_multiplier' && b.multiplier_currency)
        .map(b => b.multiplier_currency as string)
    );
    const missing = [...labelsInUse].filter(label => !(label in MULTIPLIER_CURRENCY_TO_POINTS_CURRENCY_ID));
    expect(missing).toEqual([]);
  });

  it('every mapped points-currency id actually exists in the points currency seed table', () => {
    const knownIds = new Set(GENERATED_POINTS_CURRENCIES.map(c => c.id));
    const danglingIds = Object.values(MULTIPLIER_CURRENCY_TO_POINTS_CURRENCY_ID).filter(id => !knownIds.has(id));
    expect(danglingIds).toEqual([]);
  });

  it('every earning_multiplier benefit row resolves to a known per-point value (no silently-unpriced bonus categories)', () => {
    const byId = new Map(GENERATED_POINTS_CURRENCIES.map(c => [c.id, c]));
    const unresolvable: string[] = [];
    for (const b of GENERATED_BENEFITS) {
      if (b.category !== 'earning_multiplier' || !b.multiplier_currency) continue;
      const currencyId = MULTIPLIER_CURRENCY_TO_POINTS_CURRENCY_ID[b.multiplier_currency];
      const currency = currencyId ? byId.get(currencyId) : undefined;
      if (!currency) unresolvable.push(`${b.card_id ?? b.program_id}: ${b.title}`);
    }
    expect(unresolvable).toEqual([]);
  });
});
