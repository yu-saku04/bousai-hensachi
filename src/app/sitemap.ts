import type { MetadataRoute } from "next";
import { buildResultPath, getAllMunicipalities, getAllPrefectures } from "@/lib/municipalities";

const BASE_URL = "https://bousai-hensachi.vercel.app";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const municipalities = getAllMunicipalities();
  const prefectures = getAllPrefectures();

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${BASE_URL}/`,                   lastModified: now, changeFrequency: "weekly",  priority: 1.0 },
    { url: `${BASE_URL}/ranking`,            lastModified: now, changeFrequency: "weekly",  priority: 0.9 },
    { url: `${BASE_URL}/ranking/emotional`,  lastModified: now, changeFrequency: "weekly",  priority: 0.8 },
    { url: `${BASE_URL}/ranking/social`,     lastModified: now, changeFrequency: "weekly",  priority: 0.8 },
    { url: `${BASE_URL}/methodology`,        lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${BASE_URL}/sources`,            lastModified: now, changeFrequency: "monthly", priority: 0.4 },
  ];

  const prefectureRoutes: MetadataRoute.Sitemap = prefectures.map((pref) => ({
    url: `${BASE_URL}/ranking/${encodeURIComponent(pref)}`,
    lastModified: now,
    changeFrequency: "weekly",
    priority: 0.8,
  }));

  const resultRoutes: MetadataRoute.Sitemap = municipalities
    .map((m) => {
      const path = buildResultPath(m.jisCode);
      if (!path) {
        console.warn(`sitemap: 不正jisCodeをスキップ (id=${m.id}, jisCode=${m.jisCode})`);
        return null;
      }
      return {
        url: `${BASE_URL}${path}`,
        lastModified: m.dataUpdatedAt ? new Date(m.dataUpdatedAt) : now,
        changeFrequency: "monthly" as const,
        priority: 0.7,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const routes = [...staticRoutes, ...prefectureRoutes, ...resultRoutes];
  const urls = routes.map((route) => route.url);
  const duplicates = urls.filter((url, index) => urls.indexOf(url) !== index);
  if (duplicates.length > 0) {
    throw new Error(`sitemap URL重複: ${Array.from(new Set(duplicates)).join(", ")}`);
  }

  return routes;
}
