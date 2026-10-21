import { RANGE_OPTIONS } from '@/lib/constants';
import type { RangeDays } from '@/lib/ranges';

interface RangePickerProps {
  value: RangeDays;
  onChange: (days: RangeDays) => void;
  label?: string;
}

// The date range a page is read over, offered the same way everywhere so
// "3 months" means one thing across the app (design §12.7).
export function RangePicker({ value, onChange, label = 'Date range' }: RangePickerProps) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={label}>
      {RANGE_OPTIONS.map((r) => (
        <button
          key={r.label}
          onClick={() => onChange(r.days)}
          aria-pressed={r.days === value}
          className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
            r.days === value ? 'bg-ink-900 text-sand-50 border-ink-900' : 'bg-surface text-ink-600 border-sand-200 hover:bg-sand-50'
          }`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}
