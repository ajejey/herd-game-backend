/**
 * Normalizes answers for comparison
 * Implements fuzzy matching logic
 */
export function normalizeAnswer(answer) {
  if (!answer) return '';
  
  return answer
    .toLowerCase()
    .trim()
    // Remove extra spaces
    .replace(/\s+/g, ' ')
    // Remove punctuation
    .replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, '')
    // Basic plural handling
    .replace(/s$/i, '')
    // Remove articles
    .replace(/\b(a|an|the)\b/g, '')
    .trim();
}
