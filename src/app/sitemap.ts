import type { MetadataRoute } from "next";
import { getAllMunicipalities, getAllPrefectures } from "@/lib/municipalities";

const BASE_URL = "https://bousai-hensachi.vercel.app";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const municipalities = getAllMunicipalities();
  const prefectures = getAllPrefectures();

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${BASE_URL}/`,        lastModified: now, changeFrequency: "weekly",  priority: 1.0 },
    { url: `${BASE_URL}/ranking`, lastModified: now, changeFrequency: "weekly",  priority: 0.9 },
    { url: `${BASE_URL}/sources`, lastModified: now, changeFrequency: "monthly", priority: 0.4 },
  ];

  const prefectureRoutes: MetadataRoute.Sitemap = prefectures.map((pref) => ({
    url: `${BASE_URL}/ranking/${encodeURIComponent(pref)}`,
    lastModified: now,
    changeFrequency: "weekly",
    priority: 0.8,
  }));

  const resultRoutes: MetadataRoute.Sitemap = municipalities.map((m) => ({
    url: `${BASE_URL}/result/${encodeURIComponent(m.prefecture)}/${encodeURIComponent(m.municipality)}`,
    lastModified: m.dataUpdatedAt ? new Date(m.dataUpdatedAt) : now,
    changeFrequency: "monthly",
    priority: 0.7,
  }));

  return [...staticRoutes, ...prefectureRoutes, ...resultRoutes];
}
