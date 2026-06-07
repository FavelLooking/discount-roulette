function parsePrice(text = '') {
  const match = text.match(/(?:по\s*)?(\d[\d\s]*)\s*(?:₽|руб\.?|р\b)/i);
  if (!match) return null;

  return Number(match[1].replace(/\s/g, ''));
}