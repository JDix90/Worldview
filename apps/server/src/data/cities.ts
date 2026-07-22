/**
 * Tiny gazetteer for humanizing signal coordinates ("near Wichita, US").
 * Hand-curated public facts (~290 entries): world capitals + major cities +
 * US regional coverage. Signals live on a 5° grid, so ~300 points is plenty —
 * the goal is "a name a human recognizes," not geocoding precision.
 */

export interface City {
  name: string;
  country: string;
  lat: number;
  lon: number;
}

// [name, ISO-ish country tag, lat, lon]
const C: Array<[string, string, number, number]> = [
  // ── US (broad regional coverage) ──
  ['New York', 'US', 40.71, -74.01], ['Los Angeles', 'US', 34.05, -118.24],
  ['Chicago', 'US', 41.88, -87.63], ['Houston', 'US', 29.76, -95.37],
  ['Phoenix', 'US', 33.45, -112.07], ['Philadelphia', 'US', 39.95, -75.17],
  ['San Antonio', 'US', 29.42, -98.49], ['San Diego', 'US', 32.72, -117.16],
  ['Dallas', 'US', 32.78, -96.80], ['Austin', 'US', 30.27, -97.74],
  ['Jacksonville', 'US', 30.33, -81.66], ['San Francisco', 'US', 37.77, -122.42],
  ['Columbus', 'US', 39.96, -83.00], ['Indianapolis', 'US', 39.77, -86.16],
  ['Seattle', 'US', 47.61, -122.33], ['Denver', 'US', 39.74, -104.99],
  ['Boston', 'US', 42.36, -71.06], ['Nashville', 'US', 36.16, -86.78],
  ['Detroit', 'US', 42.33, -83.05], ['Portland', 'US', 45.52, -122.68],
  ['Las Vegas', 'US', 36.17, -115.14], ['Memphis', 'US', 35.15, -90.05],
  ['Baltimore', 'US', 39.29, -76.61], ['Milwaukee', 'US', 43.04, -87.91],
  ['Albuquerque', 'US', 35.08, -106.65], ['Tucson', 'US', 32.22, -110.97],
  ['Sacramento', 'US', 38.58, -121.49], ['Kansas City', 'US', 39.10, -94.58],
  ['Atlanta', 'US', 33.75, -84.39], ['Miami', 'US', 25.76, -80.19],
  ['Tampa', 'US', 27.95, -82.46], ['Orlando', 'US', 28.54, -81.38],
  ['New Orleans', 'US', 29.95, -90.07], ['Cleveland', 'US', 41.50, -81.69],
  ['Pittsburgh', 'US', 40.44, -80.00], ['St. Louis', 'US', 38.63, -90.20],
  ['Cincinnati', 'US', 39.10, -84.51], ['Minneapolis', 'US', 44.98, -93.27],
  ['Charlotte', 'US', 35.23, -80.84], ['Raleigh', 'US', 35.78, -78.64],
  ['Salt Lake City', 'US', 40.76, -111.89], ['Boise', 'US', 43.62, -116.20],
  ['Oklahoma City', 'US', 35.47, -97.52], ['Wichita', 'US', 37.69, -97.34],
  ['Omaha', 'US', 41.26, -95.93], ['Des Moines', 'US', 41.59, -93.62],
  ['Little Rock', 'US', 34.75, -92.29], ['Louisville', 'US', 38.25, -85.76],
  ['Buffalo', 'US', 42.89, -78.88], ['Richmond', 'US', 37.54, -77.44],
  ['Birmingham', 'US', 33.52, -86.80], ['Jackson', 'US', 32.30, -90.18],
  ['Billings', 'US', 45.78, -108.50], ['Fargo', 'US', 46.88, -96.79],
  ['Sioux Falls', 'US', 43.55, -96.73], ['Cheyenne', 'US', 41.14, -104.82],
  ['El Paso', 'US', 31.76, -106.49], ['Amarillo', 'US', 35.19, -101.83],
  ['Spokane', 'US', 47.66, -117.43], ['Reno', 'US', 39.53, -119.81],
  ['Fresno', 'US', 36.74, -119.77], ['Anchorage', 'US', 61.22, -149.90],
  ['Fairbanks', 'US', 64.84, -147.72], ['Honolulu', 'US', 21.31, -157.86],
  ['Colorado Springs', 'US', 38.83, -104.82], ['Grand Junction', 'US', 39.06, -108.55],
  ['Rapid City', 'US', 44.08, -103.23], ['Duluth', 'US', 46.79, -92.10],
  ['Bangor', 'US', 44.80, -68.77], ['Burlington', 'US', 44.48, -73.21],
  ['Norfolk', 'US', 36.85, -76.29], ['Savannah', 'US', 32.08, -81.09],
  ['Knoxville', 'US', 35.96, -83.92], ['Lubbock', 'US', 33.58, -101.86],
  ['Shreveport', 'US', 32.53, -93.75], ['Mobile', 'US', 30.69, -88.04],
  // ── Canada ──
  ['Toronto', 'CA', 43.65, -79.38], ['Montreal', 'CA', 45.50, -73.57],
  ['Vancouver', 'CA', 49.28, -123.12], ['Calgary', 'CA', 51.05, -114.07],
  ['Edmonton', 'CA', 53.55, -113.49], ['Winnipeg', 'CA', 49.90, -97.14],
  ['Ottawa', 'CA', 45.42, -75.70], ['Halifax', 'CA', 44.65, -63.58],
  ['St. John’s', 'CA', 47.56, -52.71], ['Yellowknife', 'CA', 62.45, -114.37],
  ['Whitehorse', 'CA', 60.72, -135.06], ['Iqaluit', 'CA', 63.75, -68.52],
  // ── Mexico / Central America / Caribbean ──
  ['Mexico City', 'MX', 19.43, -99.13], ['Guadalajara', 'MX', 20.67, -103.35],
  ['Monterrey', 'MX', 25.69, -100.32], ['Tijuana', 'MX', 32.51, -117.04],
  ['Cancún', 'MX', 21.16, -86.85], ['Guatemala City', 'GT', 14.63, -90.51],
  ['San Salvador', 'SV', 13.69, -89.22], ['Tegucigalpa', 'HN', 14.07, -87.19],
  ['Managua', 'NI', 12.11, -86.24], ['San José', 'CR', 9.93, -84.08],
  ['Panama City', 'PA', 8.98, -79.52], ['Havana', 'CU', 23.11, -82.37],
  ['Kingston', 'JM', 18.02, -76.80], ['Santo Domingo', 'DO', 18.49, -69.90],
  ['San Juan', 'PR', 18.47, -66.11], ['Port-au-Prince', 'HT', 18.54, -72.34],
  ['Nassau', 'BS', 25.04, -77.35], ['Bridgetown', 'BB', 13.10, -59.62],
  // ── South America ──
  ['Bogotá', 'CO', 4.71, -74.07], ['Medellín', 'CO', 6.25, -75.56],
  ['Caracas', 'VE', 10.48, -66.90], ['Quito', 'EC', -0.18, -78.47],
  ['Guayaquil', 'EC', -2.19, -79.89], ['Lima', 'PE', -12.05, -77.04],
  ['La Paz', 'BO', -16.49, -68.12], ['Santiago', 'CL', -33.45, -70.67],
  ['Buenos Aires', 'AR', -34.60, -58.38], ['Córdoba', 'AR', -31.42, -64.19],
  ['Montevideo', 'UY', -34.90, -56.19], ['Asunción', 'PY', -25.26, -57.58],
  ['São Paulo', 'BR', -23.55, -46.63], ['Rio de Janeiro', 'BR', -22.91, -43.17],
  ['Brasília', 'BR', -15.79, -47.88], ['Salvador', 'BR', -12.97, -38.50],
  ['Fortaleza', 'BR', -3.72, -38.54], ['Manaus', 'BR', -3.10, -60.03],
  ['Recife', 'BR', -8.05, -34.88], ['Porto Alegre', 'BR', -30.03, -51.22],
  ['Georgetown', 'GY', 6.80, -58.16], ['Paramaribo', 'SR', 5.87, -55.17],
  ['Punta Arenas', 'CL', -53.15, -70.92], ['Ushuaia', 'AR', -54.80, -68.30],
  // ── Europe ──
  ['London', 'GB', 51.51, -0.13], ['Manchester', 'GB', 53.48, -2.24],
  ['Edinburgh', 'GB', 55.95, -3.19], ['Dublin', 'IE', 53.35, -6.26],
  ['Paris', 'FR', 48.86, 2.35], ['Lyon', 'FR', 45.76, 4.84],
  ['Marseille', 'FR', 43.30, 5.37], ['Madrid', 'ES', 40.42, -3.70],
  ['Barcelona', 'ES', 41.39, 2.17], ['Lisbon', 'PT', 38.72, -9.14],
  ['Porto', 'PT', 41.15, -8.61], ['Amsterdam', 'NL', 52.37, 4.90],
  ['Brussels', 'BE', 50.85, 4.35], ['Berlin', 'DE', 52.52, 13.41],
  ['Munich', 'DE', 48.14, 11.58], ['Frankfurt', 'DE', 50.11, 8.68],
  ['Hamburg', 'DE', 53.55, 9.99], ['Zurich', 'CH', 47.37, 8.54],
  ['Geneva', 'CH', 46.20, 6.14], ['Vienna', 'AT', 48.21, 16.37],
  ['Prague', 'CZ', 50.09, 14.42], ['Warsaw', 'PL', 52.23, 21.01],
  ['Kraków', 'PL', 50.06, 19.95], ['Budapest', 'HU', 47.50, 19.04],
  ['Rome', 'IT', 41.90, 12.50], ['Milan', 'IT', 45.46, 9.19],
  ['Naples', 'IT', 40.85, 14.27], ['Athens', 'GR', 37.98, 23.73],
  ['Copenhagen', 'DK', 55.68, 12.57], ['Stockholm', 'SE', 59.33, 18.07],
  ['Oslo', 'NO', 59.91, 10.75], ['Helsinki', 'FI', 60.17, 24.94],
  ['Tallinn', 'EE', 59.44, 24.75], ['Riga', 'LV', 56.95, 24.11],
  ['Vilnius', 'LT', 54.69, 25.28], ['Minsk', 'BY', 53.90, 27.57],
  ['Kyiv', 'UA', 50.45, 30.52], ['Odesa', 'UA', 46.48, 30.73],
  ['Lviv', 'UA', 49.84, 24.03], ['Bucharest', 'RO', 44.43, 26.10],
  ['Sofia', 'BG', 42.70, 23.32], ['Belgrade', 'RS', 44.79, 20.45],
  ['Zagreb', 'HR', 45.81, 15.98], ['Sarajevo', 'BA', 43.86, 18.41],
  ['Tirana', 'AL', 41.33, 19.82], ['Skopje', 'MK', 41.99, 21.43],
  ['Reykjavik', 'IS', 64.15, -21.94], ['Moscow', 'RU', 55.76, 37.62],
  ['St. Petersburg', 'RU', 59.93, 30.34], ['Kaliningrad', 'RU', 54.71, 20.51],
  ['Istanbul', 'TR', 41.01, 28.98], ['Ankara', 'TR', 39.93, 32.86],
  // ── Middle East ──
  ['Jerusalem', 'IL', 31.77, 35.21], ['Tel Aviv', 'IL', 32.08, 34.78],
  ['Beirut', 'LB', 33.89, 35.50], ['Damascus', 'SY', 33.51, 36.29],
  ['Amman', 'JO', 31.96, 35.95], ['Cairo', 'EG', 30.04, 31.24],
  ['Baghdad', 'IQ', 33.31, 44.37], ['Tehran', 'IR', 35.69, 51.39],
  ['Riyadh', 'SA', 24.71, 46.68], ['Jeddah', 'SA', 21.49, 39.19],
  ['Dubai', 'AE', 25.20, 55.27], ['Abu Dhabi', 'AE', 24.45, 54.38],
  ['Doha', 'QA', 25.29, 51.53], ['Kuwait City', 'KW', 29.38, 47.99],
  ['Manama', 'BH', 26.23, 50.59], ['Muscat', 'OM', 23.59, 58.41],
  ['Sanaa', 'YE', 15.35, 44.21], ['Baku', 'AZ', 40.41, 49.87],
  ['Tbilisi', 'GE', 41.72, 44.79], ['Yerevan', 'AM', 40.18, 44.51],
  // ── Africa ──
  ['Casablanca', 'MA', 33.57, -7.59], ['Algiers', 'DZ', 36.75, 3.06],
  ['Tunis', 'TN', 36.81, 10.18], ['Tripoli', 'LY', 32.89, 13.19],
  ['Dakar', 'SN', 14.72, -17.47], ['Bamako', 'ML', 12.64, -8.00],
  ['Abidjan', 'CI', 5.36, -4.01], ['Accra', 'GH', 5.60, -0.19],
  ['Lagos', 'NG', 6.52, 3.38], ['Abuja', 'NG', 9.06, 7.50],
  ['Niamey', 'NE', 13.51, 2.13], ['N’Djamena', 'TD', 12.13, 15.06],
  ['Khartoum', 'SD', 15.50, 32.56], ['Addis Ababa', 'ET', 9.03, 38.74],
  ['Mogadishu', 'SO', 2.04, 45.34], ['Nairobi', 'KE', -1.29, 36.82],
  ['Kampala', 'UG', 0.35, 32.58], ['Kigali', 'RW', -1.94, 30.06],
  ['Dar es Salaam', 'TZ', -6.79, 39.21], ['Kinshasa', 'CD', -4.44, 15.27],
  ['Luanda', 'AO', -8.84, 13.23], ['Lusaka', 'ZM', -15.39, 28.32],
  ['Harare', 'ZW', -17.83, 31.05], ['Johannesburg', 'ZA', -26.20, 28.05],
  ['Cape Town', 'ZA', -33.92, 18.42], ['Durban', 'ZA', -29.86, 31.03],
  ['Antananarivo', 'MG', -18.88, 47.51], ['Port Louis', 'MU', -20.16, 57.50],
  // ── Central / South Asia ──
  ['Kabul', 'AF', 34.56, 69.21], ['Islamabad', 'PK', 33.68, 73.05],
  ['Karachi', 'PK', 24.86, 67.01], ['Lahore', 'PK', 31.55, 74.34],
  ['Delhi', 'IN', 28.61, 77.21], ['Mumbai', 'IN', 19.08, 72.88],
  ['Bengaluru', 'IN', 12.97, 77.59], ['Chennai', 'IN', 13.08, 80.27],
  ['Kolkata', 'IN', 22.57, 88.36], ['Hyderabad', 'IN', 17.39, 78.49],
  ['Colombo', 'LK', 6.93, 79.85], ['Dhaka', 'BD', 23.81, 90.41],
  ['Kathmandu', 'NP', 27.72, 85.32], ['Thimphu', 'BT', 27.47, 89.64],
  ['Tashkent', 'UZ', 41.30, 69.24], ['Almaty', 'KZ', 43.24, 76.89],
  ['Astana', 'KZ', 51.17, 71.43], ['Bishkek', 'KG', 42.87, 74.59],
  ['Dushanbe', 'TJ', 38.56, 68.77], ['Ashgabat', 'TM', 37.96, 58.33],
  // ── East / Southeast Asia ──
  ['Beijing', 'CN', 39.90, 116.41], ['Shanghai', 'CN', 31.23, 121.47],
  ['Guangzhou', 'CN', 23.13, 113.26], ['Shenzhen', 'CN', 22.54, 114.06],
  ['Chengdu', 'CN', 30.57, 104.07], ['Xi’an', 'CN', 34.34, 108.94],
  ['Wuhan', 'CN', 30.59, 114.31], ['Harbin', 'CN', 45.80, 126.53],
  ['Ürümqi', 'CN', 43.83, 87.62], ['Lhasa', 'CN', 29.65, 91.10],
  ['Hong Kong', 'HK', 22.32, 114.17], ['Taipei', 'TW', 25.03, 121.57],
  ['Ulaanbaatar', 'MN', 47.89, 106.91], ['Pyongyang', 'KP', 39.04, 125.75],
  ['Seoul', 'KR', 37.57, 126.98], ['Busan', 'KR', 35.18, 129.08],
  ['Tokyo', 'JP', 35.68, 139.69], ['Osaka', 'JP', 34.69, 135.50],
  ['Sapporo', 'JP', 43.06, 141.35], ['Fukuoka', 'JP', 33.59, 130.40],
  ['Naha', 'JP', 26.21, 127.68], ['Hanoi', 'VN', 21.03, 105.85],
  ['Ho Chi Minh City', 'VN', 10.82, 106.63], ['Vientiane', 'LA', 17.98, 102.63],
  ['Phnom Penh', 'KH', 11.56, 104.92], ['Bangkok', 'TH', 13.76, 100.50],
  ['Yangon', 'MM', 16.87, 96.20], ['Kuala Lumpur', 'MY', 3.14, 101.69],
  ['Singapore', 'SG', 1.35, 103.82], ['Jakarta', 'ID', -6.21, 106.85],
  ['Surabaya', 'ID', -7.25, 112.75], ['Denpasar', 'ID', -8.65, 115.22],
  ['Manila', 'PH', 14.60, 120.98], ['Cebu', 'PH', 10.32, 123.89],
  // ── Oceania ──
  ['Sydney', 'AU', -33.87, 151.21], ['Melbourne', 'AU', -37.81, 144.96],
  ['Brisbane', 'AU', -27.47, 153.03], ['Perth', 'AU', -31.95, 115.86],
  ['Adelaide', 'AU', -34.93, 138.60], ['Darwin', 'AU', -12.46, 130.84],
  ['Hobart', 'AU', -42.88, 147.33], ['Auckland', 'NZ', -36.85, 174.76],
  ['Wellington', 'NZ', -41.29, 174.78], ['Christchurch', 'NZ', -43.53, 172.64],
  ['Port Moresby', 'PG', -9.44, 147.18], ['Suva', 'FJ', -18.14, 178.44],
  ['Nouméa', 'NC', -22.28, 166.46], ['Papeete', 'PF', -17.53, -149.57],
  ['Apia', 'WS', -13.85, -171.75], ['Nuku‘alofa', 'TO', -21.14, -175.20],
];

export const CITIES: City[] = C.map(([name, country, lat, lon]) => ({ name, country, lat, lon }));

const DEG = Math.PI / 180;

/** Great-circle distance in miles. */
export function distMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Initial great-circle bearing → 16-point compass word. */
export function compass16(lat1: number, lon1: number, lat2: number, lon2: number): string {
  const dLon = (lon2 - lon1) * DEG;
  const y = Math.sin(dLon) * Math.cos(lat2 * DEG);
  const x =
    Math.cos(lat1 * DEG) * Math.sin(lat2 * DEG) -
    Math.sin(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos(dLon);
  const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  const pts = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return pts[Math.round(deg / 22.5) % 16]!;
}

/** "near Wichita, US" — the closest gazetteer entry. */
export function nearestCity(lat: number, lon: number): { label: string; miles: number } {
  let best: City = CITIES[0]!;
  let bestD = Infinity;
  for (const c of CITIES) {
    const d = distMiles(lat, lon, c.lat, c.lon);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return { label: `near ${best.name}, ${best.country}`, miles: Math.round(bestD) };
}
