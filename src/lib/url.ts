/** Drop Facebook/UTM tracking parameters and anchors. */
export function cleanUrl(u: string): string {
  const url = new URL(u.trim());
  for (const k of [...url.searchParams.keys()]) {
    if (k === "fbclid" || k.startsWith("utm_") || k === "igshid") url.searchParams.delete(k);
  }
  url.hash = "";
  return url.toString();
}
