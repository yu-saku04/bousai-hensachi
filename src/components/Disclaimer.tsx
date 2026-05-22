interface DisclaimerProps {
  sourceNote?: string;
}

export default function Disclaimer({ sourceNote }: DisclaimerProps) {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800 space-y-2">
      <p className="font-semibold">⚠️ ご注意ください</p>
      {sourceNote && <p>{sourceNote}</p>}
      <p>
        本サービスの情報は防災意識の向上を目的としたものであり、正確性・完全性を保証するものではありません。
        実際の避難判断・防災対策については、必ずお住まいの自治体や国土交通省・消防庁などの
        公的機関の情報をご確認ください。
      </p>
    </div>
  );
}
