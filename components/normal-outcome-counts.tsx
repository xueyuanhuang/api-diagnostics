import {
  normalOutcomes,
  type NormalOutcomeSource,
} from '@/lib/normal-outcomes';

export function NormalOutcomeCounts({
  source,
  tiles = false,
}: {
  source: NormalOutcomeSource;
  tiles?: boolean;
}) {
  const counts = normalOutcomes(source);
  const items = [
    {
      label: 'No usage flag',
      value: counts.normal,
      color: 'bg-emerald-50 text-emerald-700',
    },
    {
      label: 'Elevated input',
      value: counts.anomaly,
      color: 'bg-amber-50 text-amber-800',
    },
    {
      label: 'Failed',
      value: counts.failed,
      color: 'bg-rose-50 text-rose-700',
    },
    ...(counts.unknown
      ? [
          {
            label: 'Needs review',
            value: counts.unknown,
            color: 'bg-slate-100 text-slate-700',
          },
        ]
      : []),
  ];
  return (
    <span
      className={
        tiles
          ? `mt-4 grid gap-2 ${counts.unknown ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3'}`
          : 'mt-3 flex flex-wrap gap-2'
      }
    >
      {items.map((item) => (
        <span
          key={item.label}
          className={
            tiles
              ? `flex flex-col-reverse items-center gap-1 rounded-xl px-2 py-3 ${item.color}`
              : `inline-flex items-center gap-2 rounded-lg px-3 py-1.5 ${item.color}`
          }
        >
          <span
            className={tiles ? 'text-xs font-medium' : 'text-sm font-medium'}
          >
            {item.label}
          </span>
          <span
            className={
              tiles
                ? 'font-mono text-2xl font-semibold'
                : 'font-mono text-base font-semibold'
            }
          >
            {item.value}
          </span>
        </span>
      ))}
    </span>
  );
}
