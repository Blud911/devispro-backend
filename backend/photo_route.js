// ══════════════════════════════════════════════════════════════
// ROUTE PHOTO / PIXTRAL — à ajouter dans server.js
// Avant le bloc HEALTH CHECK
// ══════════════════════════════════════════════════════════════

// POST /api/bot/photo
// Body : { image: "data:image/jpeg;base64,..." }
app.post('/api/bot/photo', authMiddleware, async (req, res) => {
  const { image } = req.body;
  if (!image) return res.status(400).json({ error: 'Image manquante' });

  // Extraire base64 pur (supprimer le préfixe data:image/...;base64,)
  const base64Data = image.replace(/^data:image\/[a-z]+;base64,/, '');
  const mimeMatch  = image.match(/^data:(image\/[a-z]+);base64,/);
  const mimeType   = mimeMatch ? mimeMatch[1] : 'image/jpeg';

  const systemPrompt = `Tu es un assistant pour artisans en Côte d'Ivoire.
On t'envoie une photo prise sur chantier. Tu dois analyser l'image et retourner UNIQUEMENT un JSON valide, sans texte autour.

Si c'est une PIÈCE ou un ESPACE (murs, sol, plafond visibles) :
{
  "type": "piece",
  "piece_detectee": "Salon" | "Chambre" | "Cuisine" | "Couloir" | "Salle de bain" | "Autre",
  "dimensions_estimees": { "longueur": 4.5, "largeur": 3.0 },
  "surface_estimee": 13.5,
  "confiance": "haute" | "moyenne" | "faible",
  "notes": "Carrelage 60x60 visible, murs peints en blanc",
  "type_travaux_suggere": "carrelage" | "peinture" | "faux plafond" | "plomberie" | "autre"
}

Si c'est un BON DE COMMANDE, FACTURE ou DOCUMENT avec des lignes de prix :
{
  "type": "document",
  "lignes": [
    { "designation": "Carrelage 60x60", "quantite": 15, "unite": "m²", "prix_unitaire": 3500 },
    { "designation": "Colle carrelage", "quantite": 5, "unite": "sac", "prix_unitaire": 4000 }
  ],
  "fournisseur": "nom si visible",
  "total_document": 72500,
  "notes": "Facture partielle, TVA incluse"
}

Si c'est autre chose (photo floue, personne, objet non pertinent) :
{
  "type": "inconnu",
  "message": "Je ne peux pas analyser cette image pour un devis. Prends une photo de la pièce ou d'un document de prix."
}

IMPORTANT : retourne SEULEMENT le JSON, rien d'autre.`;

  try {
    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.MISTRAL_API_KEY}`
      },
      body: JSON.stringify({
        model: 'pixtral-large-latest',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: `data:${mimeType};base64,${base64Data}` }
              },
              {
                type: 'text',
                text: systemPrompt
              }
            ]
          }
        ],
        temperature: 0.1,
        max_tokens: 800
      })
    });

    const data = await response.json();

    if (!data.choices || !data.choices[0]) {
      return res.status(500).json({ error: 'Réponse Pixtral invalide' });
    }

    const raw = data.choices[0].message.content.trim();

    // Parser le JSON retourné par Pixtral
    let parsed;
    try {
      // Nettoyer les éventuels backticks markdown
      const clean = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      parsed = JSON.parse(clean);
    } catch {
      // Si parsing échoue, retourner le texte brut
      return res.json({
        type: 'inconnu',
        message: "Je n'ai pas pu analyser l'image correctement. Réessaie avec une photo plus nette.",
        raw
      });
    }

    res.json(parsed);

  } catch (err) {
    console.error('[PHOTO] Pixtral error:', err);
    res.status(500).json({ error: 'Erreur lors de l\'analyse de la photo' });
  }
});

// ══════════════════════════════════════════════════════════════
// FIN ROUTE PHOTO
// ══════════════════════════════════════════════════════════════
