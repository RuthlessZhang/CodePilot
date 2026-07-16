export function estimateTokens(value: string) {
  return Math.ceil(value.length / 4);
}

export function truncateToTokens(value: string, maxTokens: number) {
  const maxChars = Math.max(0, maxTokens * 4);
  if (value.length <= maxChars) return value;
  if (maxChars <= 64) return value.slice(0, maxChars);
  const head = Math.floor(maxChars * 0.65);
  const tail = Math.max(0, maxChars - head - 48);
  return `${value.slice(0, head)}\n\n[truncated]\n\n${value.slice(value.length - tail)}`;
}
