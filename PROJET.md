# Momo et Jéjé cuisinent végé

Application web (mobile d'abord) qui propose les soupers de la semaine et fait la liste d'épicerie.
Buts : moins de charge mentale, moins de coûts, moins de gaspillage. Claude construit tout ; Momo et Jéjé l'utilisent,
et des amis peuvent avoir leur propre foyer.

- Site : https://momo-et-jeje-cuisinent-vege.vercel.app (ancienne adresse : grocery-eight-beta.vercel.app, toujours active)
- Code : https://github.com/LJerome17/Grocery (privé, branche `main`) ; chaque poussée sur `main` est publiée par Vercel
- Base de données : Supabase, projet `nptpjbncvqjyqeyroasg`
- Dossier local : `C:\Users\jerom\Projets\epicerie` (hors OneDrive exprès)

Ce fichier est tenu à jour à chaque changement important. Dernière mise à jour : 2026-09-30 (validation avant lancement terminée, version de lancement en ligne).

## Règles décidées avec Momo et Jéjé

**Recettes**
- Végétariennes seulement (le thon et le poulet sur plaque ont été retirés ; 4 recettes avec un ingrédient animal mineur,
  bouillon de poulet, sauce aux huîtres ou de poisson, sont gardées telles quelles).
- Jamais traduites : affichées telles qu'écrites. Seuls les articles de la liste d'épicerie et l'interface changent de langue.
- Quantités jamais adaptées : seulement des multiples entiers (×2, ×3).
- Aucune quantité inventée : ce qui manque à la source reste manquant (Soupe de lentilles p. 142 et Garlic Chili après
  l'étape 9 attendent les sources de l'utilisateur).
- Recettes de tofu seul : ligne « Légumes pour accompagner le tofu (au choix) » (article « Légumes d'accompagnement (au choix) »),
  sans légume imposé ; pour le gaspillage, le planificateur la compte comme poivrons, courgettes et pommes de terre.
- Catégories de protéine par légumineuse (pois chiches, haricots noirs, rouges, blancs, lentilles…), pas « légumineuses ».
- Photos personnelles dans `recettes/Photo_recettes/` (nom de fichier = tous les mots du titre) : elles passent avant toute autre image.

**Livre de recettes partagé**
- Le foyer de Momo et Jéjé est le livre : tous les foyers le lisent en direct, lui seul ajoute, modifie ou supprime des recettes.
  Chaque foyer a ses propres semaines et listes.
- Code d'invitation gardé secret ; bouton « Créer un nouveau code d'invitation » dans Réglages. Pas de bouton pour retirer
  un membre (décision : le code reste secret). Le dernier membre du livre ne peut pas le quitter.
- Seuls les membres du livre peuvent utiliser la lecture de liens et la copie de photos (`/api/import`, `/api/image`).
- Nom proposé pour un nouveau foyer : « Notre foyer » / « Our household » (deux foyers peuvent avoir le même nom).
- `book_household()` renvoie l'identifiant fixe de ce foyer ; `households.is_book` est une colonne calculée (non modifiable).

**Semaine**
- Une semaine = un nombre de portions + un maximum de recettes. Toujours au moins les portions demandées ;
  « moins d'extra d'abord » (moins de recettes si ça donne moins de surplus) ; un multiple coûte comme 2 portions en trop
  (multiples calculés exactement). Une semaine qui respecte les règles de variété passe toujours avant une qui les enfreint.
- Filtres stricts : saisons cochées, types de plat exclus. Variété : même type de plat max 2, même protéine max 3 (par défaut),
  pause avant de revoir une recette.
- Score : saison, note (0,25 par étoile au-dessus de 3, donc +0,5 au plus), jamais planifiée, ingrédients frais partagés
  (0,25 chacun), hasard (0 à 1,6, élargi pour des suggestions proches de l'uniforme).

**Liste d'épicerie**
- Articles en français (ou en anglais pour un foyer anglophone), jamais de franglais.
- Les plages restent (« 4 à 8 ») ; équivalences d'unités vers l'unité d'achat ; unités entières arrondies vers le haut.
- Garde-manger (93 articles : huiles, vinaigres, sauces, épices, farine, sucre, miso, câpres, nori, pâte de tomate…) listé à part.
- Tofu ferme et extra-ferme restent deux articles ; bloc de tofu = 450 g.
- Boîtes : format affiché (« 2 boîtes (540 ml) ») ; une boîte de légumineuses de 540 ml = 500 ml égouttés.
- Grains cuits dans une recette (« riz cuit », « quinoa cuit »…) achetés secs (`cooked_ratio` du catalogue).
- Épinards en sacs de 200 g (1 tasse = 30 g) ; herbes fraîches : 1 botte = 1 tasse hachée.
- Bouillon : la quantité demandée telle quelle (ils utilisent Better than Bouillon), pas de conversion en cubes.
- Une ligne peut mélanger des unités (« 24 g + 60 ml ») ; « au goût » ou « une poignée » disparaît si une autre recette donne une quantité.
- Un seul article pour les boissons végétales (soya, avoine, amande…). Balsamique blanc et piment doux sont des articles à part.

**Comptes**
- Pas d'inscription obligatoire : accès anonyme lié au navigateur ; « Rejoindre un foyer » avec le code pour un autre appareil.
- Nom d'utilisateur + mot de passe facultatif (adresse interne `nom@utilisateurs.momo-et-jeje.app`, aucun courriel envoyé).
  Un nom d'utilisateur ne peut pas être changé (Supabase enverrait un courriel à l'adresse interne).
- Supabase : fournisseur Email activé, « Confirm email » et « Secure email change » désactivés, connexions anonymes permises.

**Langue**
- Par foyer (`households.lang` : `fr` ou `en`), choisie à la création, modifiable dans Réglages.
- Interface : chaque texte est une paire `tr("français", "English")` (`src/lib/i18n.ts`). Catalogue : `ingredients.name_en`.

**Retiré à la demande**
- Rabais de la circulaire Maxi et code postal (jugés « trop cheap ») : ne pas remettre.

## Sécurité
- Ne jamais demander ni utiliser la clé secrète (service_role) ou le mot de passe de la base Supabase. La clé publique suffit.
- Les liens tapés par les gens (import de recette, copie de photo) passent par `src/lib/safeFetch.ts` :
  http(s) public seulement, vérifié à chaque redirection, délai et taille limités.
- Les photos téléversées : 1 Mo max, webp/jpeg/png. La photo d'une recette ajoutée par lien est copiée (réduite) dans Supabase.
- Accès (RLS) : un foyer ne voit que ses semaines et listes ; recettes du livre en lecture seule pour les autres ;
  `is_book` non modifiable ; le dernier membre du livre ne peut pas le quitter. Limite connue (faible) : `safeFetch` vérifie
  l'adresse avant la connexion, sans protection contre le « DNS rebinding ».

## Architecture
- Next.js 16 (App Router), React 19, Tailwind 4, TypeScript, vitest. Aucune IA à l'exécution : tout est par règles.
- `src/app/` : pages `semaine`, `liste`, `recettes` (+ `[id]`, `nouvelle`), `reglages`, `foyer`, `connexion` ;
  API `api/import` (lecture d'une recette par lien ou texte) et `api/image` (copie de la photo d'un site).
- `src/lib/` : `planner.ts` (suggestions), `shopping.ts` (liste), `parseIngredient.ts` / `parseRecipeText.ts` /
  `importRecipe.ts` (lecture des recettes), `units.ts`, `aisles.ts`, `i18n.ts`, `erreur.ts` (messages), `username.ts`,
  `starter.ts` (recettes de départ), `data.ts`, `weekPlan.ts`, `safeFetch.ts`, `bookAccess.ts` (routes réservées au livre).
- Données sources : `data/catalog.json` (258 articles, 1 024 alias, noms FR/EN, rayons, garde-manger, équivalences, format des boîtes, rapport cuit/sec), `data/recipe-meta.json`
  (type, protéine, saisons), `data/import-fixes.json` (corrections d'import), `data/photos/*.txt` (recettes en photo transcrites),
  `recettes/` (liens, textes, photos fournis par l'utilisateur).
- Recettes de départ publiées dans `public/starter/` (69 recettes + images), synchronisées par Réglages → « Mettre à jour les recettes de départ ».

## Mises à jour SQL (collées par l'utilisateur dans Supabase → SQL Editor)
L'éditeur SQL ne garde rien d'une instruction à l'autre (pas de tables temporaires) et un collage très gros (~380 Ko)
s'est corrompu : chaque instruction est autonome, fichiers < ~90 Ko, testés localement avec PGlite avant d'être donnés.

| Fichier | Contenu | État |
|---|---|---|
| 0001 à 0004 | tables, RLS, catalogue, recettes | appliquées |
| 0005 | colonnes postal_code, starter_slug, starter_seen, equiv, joined_at ; limites des photos | appliquée (partie catalogue refaite en 0006) |
| 0006 | catalogue autonome + protéines | appliquée |
| 0007 | livre de recettes partagé en lecture seule | appliquée |
| 0008 | livre déplacé vers le foyer 5e35aedc | appliquée |
| 0009 | variété par défaut 2 / 3 | appliquée |
| 0010 | légumes d'accompagnement des recettes de tofu seul | appliquée |
| 0011 | langue du foyer + noms anglais du catalogue | appliquée |
| 0012 | validation : cooked_ratio, dernier membre du livre, catalogue (258 articles), fusion boissons végétales | appliquée |
| 0013 | alias du catalogue (après 0012) | appliquée |

## Procédures
- **Publier** : `npx vitest run`, `npx tsc --noEmit`, `npx eslint src scripts`, `npm run build`, puis commit et push sur `main`.
  Toujours vérifier en ligne avant de dire que c'est fini : `npx tsx scripts/smoke-test.ts` (foyer jetable, tout le parcours)
  et `npx tsx scripts/add-recipe-test.ts` (ajout de recette).
- **Recettes de départ** : `npx tsx scripts/import-local.ts` → `scripts/fetch-images.ts` (`--force` ou supprimer l'image pour la refaire)
  → `scripts/build-starter.ts` → `scripts/build-seed.ts` ; vérifier avec `scripts/check-catalog.ts`, `scripts/list-audit.ts`, `scripts/protein-audit.ts`.
- **Icônes** : `npx tsx scripts/build-icons.ts` depuis le logo dans `Logo/` (le fichier le plus récent).
- **Validation** : `src/validation/*.test.ts` (quantités lues, conversions, liste d'épicerie sur des centaines de semaines,
  planificateur, langues) ; `scripts/validate/mapping.ts` (chaque ligne → article), `scripts/validate/quantities.ts`,
  `scripts/validate/aliases-check.ts` (alias risqués).
- **Tests d'acceptation (UAT)** : page à cocher sur téléphone, 42 tests en 6 scénarios, résultats partagés que Claude
  peut lire : https://claude.ai/artifact/D18oEMbaNwiZ9p5TtL3Eu6
- **UAT automatique** : `scripts/uat/uat-e2e.mjs` joue 34 des 42 tests dans un vrai navigateur (Edge), en foyers d'essai.
  Dernière passe (2026-09-30) : 29 réussis ; C3, C4, E1 en attente de « Mettre à jour les recettes de départ » ; C5 : 2 recettes
  ajoutées sans photo. A produit deux corrections (arrivée sur la semaine après connexion ; « Choisir une recette » sur une semaine vide).
- **Sauvegarde** : chaque lundi, l'action GitHub « Sauvegarde des recettes » copie tout le livre (recettes, ingrédients, étapes,
  photos téléversées) dans `backup/` ; lancer à la main avec `npx tsx scripts/backup-recipes.ts` ou Actions → Run workflow.
  Vercel ne republie pas pour une sauvegarde seule (`vercel.json`). La lecture hebdomadaire évite aussi la mise en pause de Supabase.

## Validation avant lancement (2026-09-30)
- Six vérifications en parallèle : quantités lues (1 208 lignes contre leurs sources), conversions et équivalences,
  liste d'épicerie (plus de 250 semaines recalculées indépendamment, FR et EN), association au catalogue, planificateur
  (600 semaines au hasard + cas comparés à l'optimum), langues et droits d'accès.
- Résultat : 343 tests (336 réussis, 4 limites connues documentées, 3 désactivés). Aucun ingrédient perdu, doublé ou mal
  multiplié ; filtres stricts jamais violés.
- Limites connues (tests `it.fails`) : le lecteur de lignes comprend mal « 30 oz … 2 cans », « + 1 c. à soupe » après le nom et
  « 1 morceau de ½ pouce » (les lignes concernées des recettes de départ sont corrigées une à une) ; aux réglages par défaut
  (20 portions, 5 recettes), les recettes de 1 à 3 portions sortent rarement (cinq recettes de 4 portions tombent pile).

## En attente
- Sources manquantes : Soupe de lentilles (p. 142), Garlic Chili (après l'étape 9).
- Recettes ajoutées dans l'application sans type de plat ou protéine : à compléter dans leur page (Préférences).
- Après chaque mise à jour des recettes de départ : Réglages → « Mettre à jour les recettes de départ » dans le foyer livre.
- Articles créés dans l'application par le livre : pas de nom anglais (restent en français sur une liste anglaise).
- Idées non faites : bouton « réessayer » à la création du foyer, choix du rayon par liste plutôt que par fenêtre.
