export function sortNewestFirst(paths: string[]): string[] {
  return paths.sort((a, b) => b.localeCompare(a));
}
