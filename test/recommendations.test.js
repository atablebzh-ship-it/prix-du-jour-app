const { formatEUR, buildRecommendation } = require('../lib/recommendations');

describe('formatEUR', () => {
  test('formats a number with 2 decimals and EUR suffix', () => {
    expect(formatEUR(19)).toBe('19.00 EUR');
    expect(formatEUR(17.5)).toBe('17.50 EUR');
    expect(formatEUR(2280.4)).toBe('2280.40 EUR');
  });

  test('coerces string numbers', () => {
    expect(formatEUR('9')).toBe('9.00 EUR');
  });
});

describe('buildRecommendation', () => {
  test('star classification', () => {
    const row = {
      menu_item_name: 'Risotto',
      classification: 'star',
      margin_per_item: 17,
      units_sold: 250,
      total_margin: 4250,
      food_cost_pct: 22.7,
    };
    const text = buildRecommendation(row);
    expect(text).toContain('RISOTTO - STAR DE LA CARTE');
    expect(text).toContain('250 ventes x 17.00 EUR de marge = 4250.00 EUR');
    expect(text).toContain('a conserver et mettre en avant');
  });

  test('rentable_peu_vendu classification', () => {
    const row = {
      menu_item_name: 'Turbot',
      classification: 'rentable_peu_vendu',
      margin_per_item: 18,
      units_sold: 35,
      total_margin: 630,
      food_cost_pct: 53.8,
    };
    const text = buildRecommendation(row);
    expect(text).toContain('TURBOT - RENTABLE MAIS PEU VENDU');
    expect(text).toContain('18.00 EUR');
    expect(text).toContain('35 ventes');
    expect(text).toContain('tester le prix');
  });

  test('populaire_peu_rentable classification includes food cost when present', () => {
    const row = {
      menu_item_name: 'Filet de boeuf',
      classification: 'populaire_peu_rentable',
      margin_per_item: 6,
      units_sold: 400,
      total_margin: 2400,
      food_cost_pct: 45,
    };
    const text = buildRecommendation(row);
    expect(text).toContain('FILET DE BOEUF - POPULAIRE MAIS PEU RENTABLE');
    expect(text).toContain('(food cost 45%)');
    expect(text).toContain('revoir la recette');
  });

  test('populaire_peu_rentable classification omits food cost when null', () => {
    const row = {
      menu_item_name: 'Filet de boeuf',
      classification: 'populaire_peu_rentable',
      margin_per_item: 6,
      units_sold: 400,
      total_margin: 2400,
      food_cost_pct: null,
    };
    const text = buildRecommendation(row);
    expect(text).not.toContain('food cost');
  });

  test('a_revoir classification', () => {
    const row = {
      menu_item_name: 'Soupe du jour',
      classification: 'a_revoir',
      margin_per_item: 1.5,
      units_sold: 4,
      total_margin: 6,
      food_cost_pct: 70,
    };
    const text = buildRecommendation(row);
    expect(text).toContain('SOUPE DU JOUR - A ABANDONNER / REVOIR');
    expect(text).toContain('peu vendu (4 ventes)');
    expect(text).toContain('retirer le plat');
  });

  test('unknown/insufficient-data classification falls back to default message', () => {
    const row = {
      menu_item_name: 'Nouveau plat',
      classification: 'insufficient_data',
      margin_per_item: null,
      units_sold: null,
      total_margin: null,
      food_cost_pct: null,
    };
    const text = buildRecommendation(row);
    expect(text).toContain('NOUVEAU PLAT : donnees insuffisantes');
  });

  test('falls back to "Ce plat" when menu_item_name is missing', () => {
    const row = { classification: 'star', margin_per_item: 1, units_sold: 1, total_margin: 1 };
    const text = buildRecommendation(row);
    expect(text).toContain('CE PLAT - STAR DE LA CARTE');
  });
});
