"use client";

interface ShareButtonsProps {
  score: number;
  municipalityName: string;
  prefecture: string;
}

export default function ShareButtons({ score, municipalityName, prefecture }: ShareButtonsProps) {
  const text = `${prefecture}${municipalityName}の防災偏差値は ${score} でした！\nあなたの街の防災レベルも確認してみよう 👇\n`;

  function openShareWindow(baseUrl: string) {
    const url = window.location.href;
    const shareUrl =
      baseUrl === "twitter"
        ? `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`
        : `https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(url + "\n" + text)}`;
    window.open(shareUrl, "_blank", "noopener,noreferrer");
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-gray-600 mb-3">結果をシェアする</p>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => openShareWindow("twitter")}
          className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-black py-3 text-white text-sm font-semibold hover:bg-gray-800 transition-colors"
          aria-label="X（Twitter）でシェア"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
          X でシェア
        </button>
        <button
          type="button"
          onClick={() => openShareWindow("line")}
          className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-green-500 py-3 text-white text-sm font-semibold hover:bg-green-600 transition-colors"
          aria-label="LINEでシェア"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 2C6.48 2 2 6.04 2 11c0 3.11 1.6 5.86 4.08 7.6L5.4 22l3.85-2.02C10.04 20.31 11 20.5 12 20.5c5.52 0 10-4.04 10-9S17.52 2 12 2z" />
          </svg>
          LINE でシェア
        </button>
      </div>
    </div>
  );
}
