# Cours Du Jour — API de viabilite et rentabilite de menu

API B2B2B destinee aux editeurs de logiciels de caisse (POS) pour donner a
leurs clients restaurateurs une aide a la decision sur leur carte : cout
matiere reel (base sur des prix marche actualises, le "cours du jour"),
viabilite de chaque plat, opportunites et risques lies aux variations de
prix, et classification de rentabilite (menu engineering).

Base URL (production) :

```
https://prix-du-jour-app.vercel.app
```

Toutes les reponses sont en JSON. Tous les montants sont en euros (EUR).

---

## 1. Authentification

L'API utilise OAuth2, grant type `client_credentials`. Chaque editeur de
caisse recoit un `client_id` / `client_secret` a la mise en place du
partenariat (ce n'est pas self-service aujourd'hui).

### POST /api/oauth/token

**Corps de la requete**

```json
{
  "grant_type": "client_credentials",
  "client_id": "votre-client-id",
  "client_secret": "votre-client-secret"
}
```

**Reponse (200)**

```json
{
  "access_token": "eyJ...",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

Le token expire au bout de 3600 secondes (1h). Toutes les autres routes
exigent l'en-tete :

```
Authorization: Bearer <access_token>
```

**Erreurs possibles** : `invalid_request` (400), `invalid_client` (401),
`unsupported_grant_type` (400).

---

## 2. Modele de donnees et perimetre

```
establishment (un restaurant client de l'editeur)
  └─ menu (une carte, ex: "Carte principale")
       └─ menu_item (un plat : nom, prix de vente)
            ├─ recipe_item (une ligne de fiche technique : ingredient + quantite)
            │      └─ ingredient (nom, unite, code de reference marche)
            │             └─ market_prices ("cours du jour" de l'ingredient)
            └─ menu_item_sales (ventes quotidiennes du plat, remontees par l'editeur)
```

Chaque `access_token` est lie a un `editeur_id`. Toutes les routes sont
protegees par des policies RLS (Row Level Security) au niveau de la base :
un editeur ne peut jamais consulter, modifier ou creer une ressource pour
un etablissement qui n'est pas le sien. A la creation d'un etablissement,
le `pos_editor_id` est deduit automatiquement du token — impossible de le
fournir explicitement ou de le falsifier.

---

## 3. Onboarding (creation des ressources)

Un restaurant est mis en place dans cet ordre : etablissement → menu →
plat(s) → ingredient(s) → fiche(s) technique(s). Chaque etape necessite
l'id renvoye par l'etape precedente.

### 3.1 POST /api/establishments

Cree un etablissement.

**Corps**

```json
{ "name": "Bistrot du Port", "foodCostTarget": 28 }
```

`foodCostTarget` est optionnel (defaut : 30, en %).

**Reponse (201)**

```json
{
  "id": "4ceaf64e-a456-4451-9843-357c4129ca65",
  "name": "Bistrot du Port",
  "slug": "bistrot-du-port-2cb873",
  "food_cost_target": 28
}
```

### 3.2 POST /api/establishments/{establishmentId}/menus

Cree une carte pour un etablissement existant.

**Corps**

```json
{ "name": "Carte principale", "isActive": true, "position": 1 }
```

`isActive` et `position` sont optionnels (defaut : `isActive=true`,
`position` = juste apres la derniere carte existante).

**Reponse (201)**

```json
{ "id": "...", "establishment_id": "...", "name": "Carte principale", "is_active": true, "position": 1 }
```

### 3.3 POST /api/establishments/{establishmentId}/menus/{menuId}/menu-items

Cree un plat sur une carte existante.

**Corps**

```json
{ "name": "Soupe de poisson", "description": "Soupe de poisson maison, croutons et rouille", "price": 12.50 }
```

`description` et `position` sont optionnels.

**Reponse (201)**

```json
{ "id": "...", "menu_id": "...", "name": "Soupe de poisson", "description": "...", "price": 12.5, "position": 1 }
```

### 3.4 POST /api/establishments/{establishmentId}/ingredients

Cree un ingredient, reutilisable dans plusieurs fiches techniques.

**Corps**

```json
{ "name": "Carotte", "unit": "kg", "marketReferenceCode": "carotte" }
```

`marketReferenceCode` est optionnel : c'est le code qui relie l'ingredient
au "cours du jour" (`market_prices`). Sans lui, l'ingredient ne beneficie
pas du suivi automatique des prix marche (viabilite, opportunites,
risques).

**Reponse (201)**

```json
{ "id": "...", "establishment_id": "...", "name": "Carotte", "unit": "kg", "market_reference_code": "carotte" }
```

### 3.5 POST /api/establishments/{establishmentId}/menu-items/{menuItemId}/recipe-items

Ajoute une ligne de fiche technique a un plat : quel ingredient, en
quelle quantite. C'est la somme des lignes d'un plat qui determine son
cout matiere estime.

**Corps**

```json
{ "ingredientId": "...", "quantity": 0.3, "unit": "kg" }
```

**Reponse (201)**

```json
{ "id": "...", "menu_item_id": "...", "ingredient_id": "...", "quantity": 0.3, "unit": "kg" }
```

---

## 4. Viabilite d'un plat

### GET /api/establishments/{establishmentId}/menu-items/{menuItemId}/viability

Renvoie le cout matiere estime, le food cost %, et si le plat est viable
par rapport au seuil configure pour l'etablissement.

**Reponse (200)**

```json
{
  "menu_item_id": "...",
  "price": 12.5,
  "estimated_cost": 0.84,
  "food_cost_pct": 6.72,
  "food_cost_target": 28,
  "viable": true,
  "fiche_technique_incomplete": false,
  "cost_incomplete": false,
  "missing_ingredients_count": 0
}
```

`viable` peut valoir `true`, `false`, ou `null` (donnees insuffisantes —
a distinguer explicitement de `false`).

---

## 5. Simulation de changement de prix

### GET /api/establishments/{establishmentId}/menu-items/{menuItemId}/price-simulation

Simule l'impact d'un changement de prix de vente sur un plat, a volume
constant (le cout matiere est suppose inchange). Le volume est estime a
partir des ventes reelles remontees sur une periode, puis annualise.

**Parametres (query string)**

| Parametre     | Requis | Description |
|---------------|--------|-------------|
| `newPrice`    | oui    | Nouveau prix de vente envisage |
| `periodStart` | non    | Debut de la periode de reference (YYYY-MM-DD). Par defaut : 30 derniers jours |
| `periodEnd`   | non    | Fin de la periode de reference (YYYY-MM-DD) |

**Reponse (200)**

```json
{
  "menu_item_id": "...",
  "current_price": 22,
  "new_price": 24,
  "estimated_cost": 3.92,
  "current_margin_per_item": 18.08,
  "new_margin_per_item": 20.08,
  "margin_delta_per_item": 2,
  "current_food_cost_pct": 17.82,
  "new_food_cost_pct": 16.33,
  "food_cost_target": 30,
  "current_viable": true,
  "new_viable": true,
  "period_start": "2026-09-15",
  "period_end": "2026-09-21",
  "units_sold_in_period": 285,
  "annualized_units_estimate": 14861,
  "period_margin_delta": 570,
  "annual_margin_delta_estimate": 29722,
  "note": "A volume constant (...), passer le prix de 22.00 EUR a 24.00 EUR ..."
}
```

Renvoie `422 donnees_insuffisantes` si la fiche technique ou le cout
matiere est incomplet.

---

## 6. Opportunites tarifaires (couts en baisse)

### GET /api/establishments/{establishmentId}/menu/pricing-opportunities

Repere les plats dont le cout matiere s'ameliore grace a une baisse
recente du prix d'un ou plusieurs ingredients sur le marche.

**Parametres (query string)**

| Parametre     | Requis | Description |
|---------------|--------|-------------|
| `lookbackDays`| non    | Fenetre de comparaison en jours (defaut 30) |
| `minDropPct`  | non    | Baisse minimale en % pour etre remontee (defaut 5) |

**Reponse (200)**

```json
{
  "establishment_id": "...",
  "lookback_days": 30,
  "min_drop_pct": 5,
  "opportunities": [
    {
      "menu_item_id": "...",
      "menu_item_name": "Ratatouille",
      "price": 14,
      "food_cost_pct": 2.83,
      "viable": true,
      "favorable_ingredients": [
        { "ingredient": "Courgette", "pct_change": -13.54, "latest_price": 0.99 }
      ]
    }
  ]
}
```

---

## 7. Risques tarifaires (couts en hausse)

### GET /api/establishments/{establishmentId}/menu/price-risks

Symetrique de l'endpoint precedent : repere les plats dont le cout
matiere se degrade a cause d'une hausse recente d'un ingredient, avant
que la marge ne s'effondre.

**Parametres (query string)**

| Parametre        | Requis | Description |
|------------------|--------|-------------|
| `lookbackDays`   | non    | Fenetre de comparaison en jours (defaut 30) |
| `minIncreasePct` | non    | Hausse minimale en % pour etre remontee (defaut 10) |

**Reponse (200)**

```json
{
  "establishment_id": "...",
  "lookback_days": 30,
  "min_increase_pct": 10,
  "risks": [
    {
      "menu_item_id": "...",
      "menu_item_name": "Ratatouille",
      "price": 14,
      "food_cost_pct": 15.58,
      "viable": true,
      "risky_ingredients": [
        { "ingredient": "Aubergine", "pct_change": 19.6, "latest_price": 5.95 }
      ]
    }
  ]
}
```

---

## 8. Remontee des ventes

### POST /api/establishments/{establishmentId}/menu/sales

Permet a l'editeur de remonter les ventes quotidiennes par plat. Ces
donnees alimentent la classification de rentabilite (section 9) et la
simulation de prix (section 5).

**Corps**

```json
{
  "records": [
    { "menuItemId": "...", "saleDate": "2026-09-20", "quantity": 12 },
    { "menuItemId": "...", "saleDate": "2026-09-21", "quantity": 15 }
  ]
}
```

- Maximum 500 enregistrements par appel.
- Chaque enregistrement fait un **upsert** sur `(menuItemId, saleDate)` :
  renvoyer une correction pour une date deja enregistree remplace la
  quantite.

**Reponse (200)**

```json
{
  "establishment_id": "...",
  "upserted_count": 2,
  "records": [
    { "menu_item_id": "...", "sale_date": "2026-09-20", "quantity": 12 },
    { "menu_item_id": "...", "sale_date": "2026-09-21", "quantity": 15 }
  ]
}
```

---

## 9. Classification de rentabilite (menu engineering)

### GET /api/establishments/{establishmentId}/menu/engineering

Croise popularite (volume de ventes) et rentabilite (marge par plat) sur
une periode donnee, et classe chaque plat dans l'un des 4 groupes
classiques du "menu engineering". Chaque plat renvoie egalement une
`recommendation` en langage naturel, prete a afficher dans le logiciel de
caisse.

**Parametres (query string, obligatoires)**

| Parametre     | Description |
|---------------|-------------|
| `periodStart` | Debut de periode (YYYY-MM-DD) |
| `periodEnd`   | Fin de periode (YYYY-MM-DD) |

**Classifications possibles**

| Valeur | Signification | Action suggeree |
|---|---|---|
| `star` | Forte popularite + forte marge | A conserver, mettre en avant |
| `rentable_peu_vendu` | Forte marge, faible volume | Travailler prix / presentation / communication |
| `populaire_peu_rentable` | Fort volume, faible marge | Priorite absolue : revoir recette ou prix |
| `a_revoir` | Faible volume, faible marge | Envisager de retirer le plat |
| `donnees_insuffisantes` | Pas de vente sur la periode, ou fiche technique/cout incomplet | — |

**Reponse (200)**

```json
{
  "establishment_id": "...",
  "period_start": "2026-09-15",
  "period_end": "2026-09-21",
  "popularity_threshold": 94.68,
  "profitability_threshold": 16.0192,
  "items": [
    {
      "menu_item_id": "...",
      "menu_item_name": "Risotto",
      "price": 22,
      "estimated_cost": 3.92,
      "food_cost_pct": 17.82,
      "viable": true,
      "margin_per_item": 18.08,
      "units_sold": 285,
      "total_margin": 5152.8,
      "classification": "star",
      "recommendation": "RISOTTO - STAR DE LA CARTE : 285 ventes x 18.08 EUR de marge = 5152.80 EUR generes. Forte popularite et excellente rentabilite -> a conserver et mettre en avant."
    }
  ]
}
```

- `popularity_threshold` = 70% du volume moyen de vente par plat sur la
  periode (regle classique du menu engineering).
- `profitability_threshold` = marge moyenne ponderee par les volumes
  (marge totale generee / total des ventes sur la periode).

---

## 10. Format des erreurs

Toutes les erreurs suivent le meme format :

```json
{ "error": "code_erreur", "error_description": "explication en francais" }
```

| Code HTTP | `error` | Signification |
|---|---|---|
| 400 | `invalid_request` | Parametre manquant ou invalide |
| 401 | `invalid_token` | Token absent, invalide ou expire |
| 401 | `invalid_client` | client_id / client_secret incorrects (endpoint OAuth) |
| 404 | `not_found` | Ressource introuvable ou hors perimetre de l'editeur |
| 405 | `method_not_allowed` | Methode HTTP non supportee sur cette route |
| 422 | `donnees_insuffisantes` | Simulation/analyse impossible (fiche technique ou cout incomplet) |
| 500 | `server_error` | Erreur interne |

---

## 11. Exemple d'integration complete (onboarding + analyse)

```bash
TOKEN=$(curl -s -X POST https://prix-du-jour-app.vercel.app/api/oauth/token \
  -H "Content-Type: application/json" \
  -d '{"grant_type":"client_credentials","client_id":"...","client_secret":"..."}' \
  | jq -r .access_token)

# 1. Creer l'etablissement
EST_ID=$(curl -s -X POST https://prix-du-jour-app.vercel.app/api/establishments \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Bistrot du Port","foodCostTarget":28}' | jq -r .id)

# 2. Creer une carte
MENU_ID=$(curl -s -X POST https://prix-du-jour-app.vercel.app/api/establishments/$EST_ID/menus \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Carte principale"}' | jq -r .id)

# 3. Creer un plat
ITEM_ID=$(curl -s -X POST https://prix-du-jour-app.vercel.app/api/establishments/$EST_ID/menus/$MENU_ID/menu-items \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Soupe de poisson","price":12.50}' | jq -r .id)

# 4. Creer un ingredient relie au cours du jour
ING_ID=$(curl -s -X POST https://prix-du-jour-app.vercel.app/api/establishments/$EST_ID/ingredients \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Carotte","unit":"kg","marketReferenceCode":"carotte"}' | jq -r .id)

# 5. Relier l'ingredient au plat (fiche technique)
curl -s -X POST https://prix-du-jour-app.vercel.app/api/establishments/$EST_ID/menu-items/$ITEM_ID/recipe-items \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"ingredientId":"'$ING_ID'","quantity":0.3,"unit":"kg"}'

# 6. Consulter la viabilite du plat
curl -s https://prix-du-jour-app.vercel.app/api/establishments/$EST_ID/menu-items/$ITEM_ID/viability \
  -H "Authorization: Bearer $TOKEN"
```

---

## 12. Feuille de route (transparence)

- [ ] Vue portefeuille agregee (tous les etablissements d'un editeur)
- [ ] Historique / tendance dans le temps (au-dela d'une seule periode)
- [ ] Webhooks (notification push au lieu de polling)
- [ ] Endpoints de mise a jour / suppression (aujourd'hui : creation
      uniquement pour establishments, menus, menu_items, ingredients,
      recipe_items)
