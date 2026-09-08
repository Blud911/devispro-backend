-- ══════════════════════════════════════════════════════════════
-- DevisPro CI — schema.sql
-- ══════════════════════════════════════════════════════════════

-- Artisans (comptes utilisateurs)
CREATE TABLE IF NOT EXISTS artisans (
  id             UUID PRIMARY KEY,
  nom            VARCHAR(100) NOT NULL,
  prenom         VARCHAR(100),
  telephone      VARCHAR(20) UNIQUE NOT NULL,
  metier         VARCHAR(100) NOT NULL,
  email          VARCHAR(150),           -- facultatif : contact de l'artisan (pas d'unicité, pas de vérification)
  password_hash  TEXT NOT NULL,
  logo_url       TEXT,
  plan           VARCHAR(20) DEFAULT 'gratuit',  -- gratuit | starter | pro
  devis_count    INTEGER DEFAULT 0,
  created_at     TIMESTAMP DEFAULT NOW()
);

-- Devis
CREATE TABLE IF NOT EXISTS devis (
  id                UUID PRIMARY KEY,
  artisan_id        UUID REFERENCES artisans(id) ON DELETE CASCADE,
  numero            VARCHAR(50) NOT NULL,
  client_nom        VARCHAR(150) NOT NULL,
  client_telephone  VARCHAR(20),
  client_email      VARCHAR(150),           -- facultatif : envoi du PDF par email (Brevo)
  objet             TEXT,
  type_travaux      VARCHAR(100),
  lignes            JSONB NOT NULL,         -- [{ designation, quantite, unite, prix_unitaire }]
  surfaces          JSONB DEFAULT '[]',     -- [{ nom_piece, longueur, largeur, surface }]
  main_oeuvre       NUMERIC(12,0) DEFAULT 0,
  acompte           NUMERIC(12,0) DEFAULT 0,
  total             NUMERIC(12,0) NOT NULL,
  statut            VARCHAR(20) DEFAULT 'brouillon',  -- brouillon | envoye | accepte | paye | annule
  pdf_url           TEXT,
  created_at        TIMESTAMP DEFAULT NOW()
);

-- Tarifs mémorisés par artisan (autocomplétion)
CREATE TABLE IF NOT EXISTS tarifs (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  artisan_id     UUID REFERENCES artisans(id) ON DELETE CASCADE,
  designation    VARCHAR(200) NOT NULL,
  unite          VARCHAR(50) DEFAULT 'unité',
  prix_unitaire  NUMERIC(12,0) NOT NULL,
  usage_count    INTEGER DEFAULT 1,
  updated_at     TIMESTAMP DEFAULT NOW(),
  UNIQUE (artisan_id, designation)
);

-- Index
CREATE INDEX IF NOT EXISTS idx_devis_artisan    ON devis(artisan_id);
CREATE INDEX IF NOT EXISTS idx_devis_statut     ON devis(statut);
CREATE INDEX IF NOT EXISTS idx_tarifs_artisan   ON tarifs(artisan_id);
CREATE INDEX IF NOT EXISTS idx_tarifs_usage     ON tarifs(usage_count DESC);

-- ══════════════════════════════════════════════════════════════
-- MIGRATIONS (bases de données déjà créées avant l'ajout d'une colonne)
-- Idempotent : sûr à rejouer à chaque déploiement.
-- ══════════════════════════════════════════════════════════════
ALTER TABLE devis ADD COLUMN IF NOT EXISTS client_email VARCHAR(150);
ALTER TABLE artisans ADD COLUMN IF NOT EXISTS email VARCHAR(150);
