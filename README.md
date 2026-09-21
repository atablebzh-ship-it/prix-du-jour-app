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

### 3.6 Modifier / supprimer une ressource (PATCH / DELETE)

Chacune des 5 ressources ci-dessus (establishment, menu, menu-item,
ingredient, recipe-item) supporte aussi `PATCH` (modification partielle)
et `DELETE`, sur la **meme route** que la creation, en ciblant la
ressource par un identifiant en **query string** plutot qu'un segment
d'URL supplementaire (regroupement necessaire pour rester sous la limite
de fonctions serverless du plan Vercel Hobby — voir la note technique en
fin de document).

| Ressource | PATCH / DELETE |
|---|---|
| Etablissement | `/api/establishments?establishmentId=...` |
| Menu | `/api/establishments/{establishmentId}/menus?menuId=...` |
| Plat | `/api/establishments/{establishmentId}/menus/{menuId}/menu-items?menuItemId=...` |
| Ingredient | `/api/establishments/{establishmentId}/ingredients?ingredientId=...` |
| Ligne de fiche technique | `/api/establishments/{establishmentId}/menu-items/{menuItemId}/recipe-items?recipeItemId=...` |

**PATCH** : au moins un champ modifiable dans le corps (mêmes champs que
la creation, tous optionnels). Renvoie la ressource a jour (200), ou
`404 not_found` si elle n'existe pas / n'appartient pas a cet
etablissement.

**DELETE** : renvoie `204` (corps vide) si la suppression reussit,
`404 not_found` si la ressource n'existe pas.

Cascades et protections a connaitre :

- Supprimer un **etablissement** supprime aussi ses menus, plats, ventes
  et instantanes (cascade base de donnees), ainsi que ses ingredients et
  fiches techniques (purges explicitement par l'API avant la suppression
  finale). **Irreversible.**
- Supprimer un **menu** supprime ses plats (et leurs ventes, instantanes,
  fiches techniques).
- Supprimer un **plat** supprime sa fiche technique (et ses ventes,
  instantanes).
- Supprimer un **ingredient** encore utilise dans une ou plusieurs
  fiches techniques est **refuse** (`409 conflict`) — il faut d'abord
  retirer les lignes de recette concernees, pour eviter de casser
  silencieusement le calcul de cout d'un plat.

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

## 10. Historique et evolution dans le temps

Permet de capturer des instantanes periodiques (prix, cout, marge, ventes,
classification) pour chaque plat, puis de consulter leur evolution au fil
du temps. C'est ce qui permet de repondre a des questions comme *"tu as
vendu 1850 risottos cette annee"* ou *"ton cout matiere est passe de 4,80
EUR a 5,35 EUR"*.

### 10.1 POST /api/establishments/{establishmentId}/menu/snapshot

Capture un instantane de tous les plats de l'etablissement pour la
periode donnee, et le sauvegarde. A appeler periodiquement (ex : une fois
par mois) par le logiciel de caisse. Un appel avec la meme periode
ecrase (upsert) l'instantane precedent — pas de risque de doublon si
l'appel est rejoue.

**Parametres (query string, obligatoires)**

| Parametre     | Description |
|---------------|-------------|
| `periodStart` | Debut de periode (YYYY-MM-DD) |
| `periodEnd`   | Fin de periode (YYYY-MM-DD) |

**Reponse (200)**

```json
{
  "establishment_id": "...",
  "period_start": "2026-09-01",
  "period_end": "2026-09-30",
  "snapshotted_count": 4
}
```

### 10.2 GET /api/establishments/{establishmentId}/menu/history

Renvoie l'historique complet des instantanes captures pour un plat, du
plus ancien au plus recent, avec un resume : total des ventes cumulees
sur tout l'historique, marge totale generee, et evolution entre le
premier et le dernier instantane.

**Parametres (query string, obligatoires)**

| Parametre    | Description |
|--------------|-------------|
| `menuItemId` | Identifiant du plat |

**Reponse (200)**

```json
{
  "establishment_id": "...",
  "menu_item_id": "...",
  "menu_item_name": "Risotto",
  "snapshots_count": 2,
  "total_units_sold_all_time": 405,
  "total_margin_generated_all_time": 7209.6,
  "evolution": {
    "from_period": { "start": "2026-08-01", "end": "2026-08-31" },
    "to_period": { "start": "2026-09-15", "end": "2026-09-21" },
    "price_change": 0,
    "estimated_cost_change": 0.4,
    "estimated_cost_change_pct": 10.2,
    "margin_per_item_change": -0.4
  },
  "snapshots": [
    { "period_start": "2026-08-01", "period_end": "2026-08-31", "price": 22, "estimated_cost": 3.92, "food_cost_pct": 17.82, "margin_per_item": 18.08, "units_sold": 123, "total_margin": 2223.84, "classification": "star", "captured_at": "..." },
    { "period_start": "2026-09-15", "period_end": "2026-09-21", "price": 22, "estimated_cost": 4.32, "food_cost_pct": 19.64, "margin_per_item": 17.68, "units_sold": 282, "total_margin": 4985.76, "classification": "star", "captured_at": "..." }
  ]
}
```

`evolution` n'est present que si au moins 2 instantanes existent pour ce
plat ; `null` sinon.

---

## 11. Vue portefeuille (tous les etablissements de l'editeur)

### GET /api/portfolio/engineering

Meme classification que la section 9, mais agregee sur **tous les
etablissements** de l'editeur authentifie en un seul appel — pense pour un
tableau de bord editeur qui gere plusieurs restaurants clients. Le
perimetre est automatiquement limite aux etablissements de l'editeur du
token (RLS) : aucun parametre d'editeur a fournir.

**Parametres (query string, obligatoires)**

| Parametre     | Description |
|---------------|-------------|
| `periodStart` | Debut de periode (YYYY-MM-DD) |
| `periodEnd`   | Fin de periode (YYYY-MM-DD) |

**Reponse (200)**

```json
{
  "period_start": "2026-09-15",
  "period_end": "2026-09-21",
  "establishments_count": 2,
  "items_count": 5,
  "classification_counts": {
    "star": 1,
    "rentable_peu_vendu": 1,
    "populaire_peu_rentable": 1,
    "a_revoir": 1,
    "donnees_insuffisantes": 1
  },
  "total_margin_across_portfolio": 8666.38,
  "priority_items": [
    {
      "establishment_id": "...",
      "establishment_name": "Restaurant de test (dev)",
      "menu_item_id": "...",
      "menu_item_name": "Entrecote",
      "classification": "populaire_peu_rentable",
      "margin_per_item": 12.105,
      "units_sold": 200,
      "recommendation": "ENTRECOTE - POPULAIRE MAIS PEU RENTABLE : ..."
    }
  ],
  "establishments": [
    {
      "establishment_id": "...",
      "establishment_name": "Restaurant de test (dev)",
      "items": [ /* meme structure que la section 9, avec recommendation */ ]
    }
  ]
}
```

- `priority_items` : tous les plats `populaire_peu_rentable` ou
  `a_revoir`, tous etablissements confondus, tries par volume de ventes
  decroissant — la ou concentrer l'attention en premier.
- `total_margin_across_portfolio` : somme de la marge generee par tous
  les plats classifies sur la periode, tous etablissements confondus.

---

## 12. Webhooks (notifications push)

Alternative au polling : plutot que d'appeler regulierement
`/menu/engineering` ou `/menu/price-risks` pour savoir si quelque chose a
change, l'editeur peut s'abonner et etre notifie automatiquement.

**Declenchement** : les webhooks se declenchent au moment de l'appel
`POST /menu/snapshot` (section 10.1) — c'est deja le moment ou l'API
recalcule les classifications de chaque plat, donc le point naturel pour
detecter un changement. Il n'y a pas de job planifie ou de polling
interne : sans appel a `/menu/snapshot`, aucun webhook n'est envoye.

**Evenements disponibles**

| Evenement | Declenche quand |
|---|---|
| `classification_change` | Un plat change de categorie menu engineering (ex: `star` -> `populaire_peu_rentable`) entre l'instantane precedent et le nouveau. |
| `price_risk` | Un ingredient a augmente significativement (mêmes seuils que `/menu/price-risks`, par defaut 30 jours / +10%), menacant la marge d'un ou plusieurs plats. |
| `price_opportunity` | Un ingredient a baisse significativement (mêmes seuils que `/menu/pricing-opportunities`, par defaut 30 jours / -5%). |

### 12.1 POST /api/webhooks

Cree un abonnement.

**Corps**

```json
{ "url": "https://exemple-caisse.fr/webhooks/cours-du-jour", "events": ["classification_change", "price_risk", "price_opportunity"] }
```

`url` doit etre en `https://`. `events` est un tableau non vide parmi les
3 valeurs ci-dessus.

**Reponse (201)**

```json
{
  "id": "...",
  "url": "https://exemple-caisse.fr/webhooks/cours-du-jour",
  "events": ["classification_change", "price_risk", "price_opportunity"],
  "is_active": true,
  "created_at": "...",
  "secret": "bd0d2c5e..."
}
```

`secret` n'est renvoye **qu'une seule fois**, a la creation. Il sert a
verifier la signature HMAC-SHA256 jointe a chaque webhook recu (voir plus
bas) — a conserver precieusement cote editeur, il n'est plus jamais
renvoye ensuite (`GET`/`PATCH` le masquent).

### 12.2 GET /api/webhooks

Liste les abonnements de l'editeur authentifie (sans le `secret`).

### 12.3 PATCH /api/webhooks?subscriptionId=...

Corps : `{ "url"?, "events"?, "isActive"? }` — au moins un champ. Utile
notamment pour desactiver temporairement un abonnement (`isActive: false`)
sans le supprimer.

### 12.4 DELETE /api/webhooks?subscriptionId=...

Supprime l'abonnement. Renvoie `204`.

### 12.5 Format d'un webhook recu

Chaque appel groupe tous les evenements pertinents pour cet abonnement en
un seul `POST` :

```json
{
  "establishment_id": "...",
  "establishment_name": "Bistrot du Port",
  "sent_at": "2026-09-21T16:29:43.000Z",
  "events": [
    {
      "type": "classification_change",
      "menu_item_id": "...",
      "menu_item_name": "Turbot",
      "previous_classification": "star",
      "new_classification": "rentable_peu_vendu",
      "margin_per_item": 18,
      "units_sold": 35
    }
  ]
}
```

**En-tete `X-Webhook-Signature`** : `sha256=<hex>`, un HMAC-SHA256 du
corps brut (avant parsing JSON) calcule avec le `secret` de l'abonnement.
A recalculer cote editeur sur le corps brut recu pour verifier que
l'appel vient bien de Cours Du Jour :

```python
import hmac, hashlib
signature = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
# comparer a la valeur apres "sha256=" dans l'en-tete recu
```

**Fiabilite** : un seul essai par evenement, timeout de 8 secondes,
aucune retentative automatique en cas d'echec. Un webhook qui echoue ne
fait jamais echouer l'appel `/menu/snapshot` lui-meme. Chaque tentative
(succes ou echec) est journalisee cote serveur pour diagnostic.

---

## 13. Format des erreurs

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

## 14. Exemple d'integration complete (onboarding + analyse)

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

## 15. Feuille de route (transparence)

- [x] Vue portefeuille agregee (tous les etablissements d'un editeur)
- [x] Historique / tendance dans le temps (au-dela d'une seule periode)
- [x] Endpoints de mise a jour / suppression (PATCH / DELETE sur
      establishments, menus, menu_items, ingredients, recipe_items)
- [x] Webhooks (notification push au lieu de polling)

**Note technique** : l'hebergement (plan Vercel Hobby, gratuit) limite a
12 fonctions serverless par deploiement. Les endpoints
`pricing-opportunities`, `price-risks`, `sales`, `engineering`,
`snapshot` et `history` sont regroupes dans un seul fichier
(`menu/[action].js`) qui route en interne selon le segment d'URL. Le
PATCH/DELETE des 5 ressources d'onboarding (establishments, menus,
menu-items, ingredients, recipe-items) est de la meme facon regroupe
dans le fichier `index.js` deja existant de chaque ressource, en routant
sur la methode HTTP + un identifiant en query string plutot qu'un
segment d'URL supplementaire. La gestion des abonnements webhook
(`api/webhooks/index.js`) est le seul veritable nouveau fichier de cette
serie de fonctionnalites : on est passe de 10 a 11 fonctions serverless,
il en reste 1 de marge sous la limite du plan gratuit. Tout nouvel
endpoint devra suivre le meme principe de regroupement, ou l'hebergement
devra passer sur un plan payant.
