// Nom de fichier interne pour un élément (versions, commentaires) : son chemin encodé,
// ou une empreinte quand l'encodage dépasserait la longueur permise par le système de
// fichiers (chemins longs et accentués).
import { createHash } from 'crypto'

export function storageKey(id) {
  const encoded = encodeURIComponent(id)
  if (encoded.length <= 180) return encoded
  return `h-${createHash('sha1').update(id).digest('hex')}`
}
