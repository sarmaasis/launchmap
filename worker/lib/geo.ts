export type GeoPoint = { country: string; city: string; lat: number; lng: number };

const CENTROIDS: Record<string, GeoPoint> = {
  US: { country: "US", city: "United States", lat: 39.8, lng: -98.5 },
  IN: { country: "IN", city: "India", lat: 20.6, lng: 79.0 },
  GB: { country: "GB", city: "United Kingdom", lat: 54.0, lng: -2.0 },
  DE: { country: "DE", city: "Germany", lat: 51.2, lng: 10.4 },
  FR: { country: "FR", city: "France", lat: 46.2, lng: 2.2 },
  BR: { country: "BR", city: "Brazil", lat: -14.2, lng: -51.9 },
  JP: { country: "JP", city: "Japan", lat: 36.2, lng: 138.3 },
  AU: { country: "AU", city: "Australia", lat: -25.3, lng: 133.8 },
  CA: { country: "CA", city: "Canada", lat: 56.1, lng: -106.3 },
  SG: { country: "SG", city: "Singapore", lat: 1.35, lng: 103.8 },
  NL: { country: "NL", city: "Netherlands", lat: 52.1, lng: 5.3 },
  NG: { country: "NG", city: "Nigeria", lat: 9.1, lng: 8.7 },
  KR: { country: "KR", city: "South Korea", lat: 35.9, lng: 127.8 },
  SE: { country: "SE", city: "Sweden", lat: 60.1, lng: 18.6 },
  ES: { country: "ES", city: "Spain", lat: 40.5, lng: -3.7 },
  IT: { country: "IT", city: "Italy", lat: 41.9, lng: 12.6 },
  MX: { country: "MX", city: "Mexico", lat: 23.6, lng: -102.5 },
  ID: { country: "ID", city: "Indonesia", lat: -0.8, lng: 113.9 },
  AE: { country: "AE", city: "UAE", lat: 23.4, lng: 53.8 },
  ZA: { country: "ZA", city: "South Africa", lat: -30.6, lng: 22.9 },
};

export function geoFromCountry(code: string | null | undefined): GeoPoint {
  const key = (code ?? "US").toUpperCase();
  return CENTROIDS[key] ?? { country: key.slice(0, 2), city: key, lat: 20, lng: 0 };
}

export function jitter(point: GeoPoint, seed: string): GeoPoint {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const dLat = ((h % 800) - 400) / 100;
  const dLng = (((h / 800) | 0) % 800 - 400) / 50;
  return { ...point, lat: point.lat + dLat, lng: point.lng + dLng };
}
