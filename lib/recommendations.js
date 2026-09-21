// Genere une phrase de recommandation en langage naturel, prete a afficher
// dans le logiciel de caisse, a partir d'une ligne de classification
// "menu engineering" (classification + margin_per_item + units_sold +
// total_margin + food_cost_pct). Partage entre l'endpoint par etablissement
// (menu/engineering) et l'endpoint portefeuille (portfolio/engineering).
function formatEUR(n) {
  return `${Number(n).toFixed(2)} EUR`;
}

function buildRecommendation(row) {
  const name = (row.menu_item_name || 'Ce plat').toUpperCase();
  const margin = row.margin_per_item !== null ? Number(row.margin_per_item) : null;
  const units = row.units_sold !== null ? Number(row.units_sold) : null;
  const totalMargin = row.total_margin !== null ? Number(row.total_margin) : null;
  const foodCostPct = row.food_cost_pct !== null ? Number(row.food_cost_pct) : null;

  switch (row.classification) {
    case 'star':
      return `${name} - STAR DE LA CARTE : ${units} ventes x ${formatEUR(margin)} de marge = ${formatEUR(totalMargin)} generes. Forte popularite et excellente rentabilite -> a conserver et mettre en avant.`;
    case 'rentable_peu_vendu':
      return `${name} - RENTABLE MAIS PEU VENDU : marge unitaire correcte (${formatEUR(margin)}), mais seulement ${units} ventes sur la periode. Le probleme n'est peut-etre pas le cout matiere -> tester le prix, la presentation ou le positionnement du plat.`;
    case 'populaire_peu_rentable':
      return `${name} - POPULAIRE MAIS PEU RENTABLE : ${units} ventes, mais seulement ${formatEUR(margin)} de marge par plat${foodCostPct !== null ? ` (food cost ${foodCostPct}%)` : ''}. Priorite absolue -> revoir la recette ou ajuster le prix.`;
    case 'a_revoir':
      return `${name} - A ABANDONNER / REVOIR : peu vendu (${units} ventes) et peu rentable (${formatEUR(margin)} de marge). Envisager de retirer le plat de la carte ou de le repositionner completement.`;
    default:
      return `${name} : donnees insuffisantes sur cette periode (aucune vente enregistree, ou fiche technique/cout matiere incomplet) pour classer ce plat.`;
  }
}

module.exports = { formatEUR, buildRecommendation };
