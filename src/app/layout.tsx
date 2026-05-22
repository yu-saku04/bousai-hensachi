import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const SITE_URL = "https://bousai-hensachi.vercel.app";
const SITE_NAME = "全国防災偏差値";
const SITE_DESCRIPTION =
  "市区町村ごとの防災リスクを偏差値でわかりやすく数値化。洪水・地震・火災・高齢化リスクと避難所余裕度を確認できます。";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} | あなたの街の災害リスクを数値化`,
    template: `%s | ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  keywords: "防災, 偏差値, 災害リスク, 避難所, 市区町村, ハザードマップ",
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title: `${SITE_NAME} | あなたの街の災害リスクを数値化`,
    description: SITE_DESCRIPTION,
    url: SITE_URL,
    locale: "ja_JP",
  },
  twitter: {
    card: "summary",
    title: `${SITE_NAME} | あなたの街の災害リスクを数値化`,
    description: SITE_DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" className={`${geistSans.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-gray-50">{children}</body>
    </html>
  );
}
