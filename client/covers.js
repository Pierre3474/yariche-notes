// Galerie de couvertures : œuvres du domaine public (Metropolitan Museum of Art, CC0) et
// images de la NASA, recadrées en 1600 × 500 dans public/covers/ (miniatures dans mini/).
// Crédits complets : THIRD_PARTY_NOTICES.md
export const COVER_GALLERY = [
  ['Peinture', [
    ['vague-hokusai', 'Hokusai, Sous la vague au large de Kanagawa'],
    ['champ-de-ble-van-gogh', 'Van Gogh, Champ de blé avec cyprès'],
    ['oliviers-van-gogh', 'Van Gogh, Oliviers'],
    ['mont-holyoke-cole', 'Thomas Cole, Vue depuis le mont Holyoke'],
    ['andes-church', 'Frederic Edwin Church, Le Cœur des Andes'],
    ['lac-louise-bierstadt', 'Albert Bierstadt, Rocheuses canadiennes (lac Louise)'],
    ['port-gloucester-lane', 'Fitz Henry Lane, Stage Fort et le port de Gloucester'],
    ['jardin-argenteuil-manet', 'Manet, La Famille Monet au jardin à Argenteuil'],
  ]],
  ['Espace', [
    ['nebuleuse-carina-webb', 'Nébuleuse de la Carène (télescope James Webb)'],
    ['bille-bleue', 'La Terre, « Blue Marble »'],
    ['aurore-iss', 'Aurore boréale vue depuis la Station spatiale'],
    ['lumieres-nocturnes', 'Lumières des villes, côte atlantique de l’Amérique du Sud'],
    ['voie-lactee', 'Le centre de la Voie lactée (Spitzer)'],
  ]],
]
const PHOTOS = new Set(COVER_GALLERY.flatMap(([, items]) => items.map(([slug]) => slug)))

// Valeur enregistrée → arrière-plan : « gradient-N » (classe CSS), « photo-<nom> » (galerie)
// ou « file:<chemin dans le coffre> » (image choisie par la personne)
export function coverStyle(cover) {
  if (!cover) return null
  if (cover.startsWith('photo-') && PHOTOS.has(cover.slice(6))) return { image: `/covers/${cover.slice(6)}.jpg` }
  if (cover.startsWith('file:')) return { image: `/api/vault-file?${new URLSearchParams({ path: cover.slice(5) })}` }
  if (/^gradient-\d$/.test(cover)) return { className: `cover-${cover}` }
  return null
}
