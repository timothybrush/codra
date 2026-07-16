import type { CSSProperties } from 'react';
import { Clock } from 'lucide-react';
import { Select } from '@client/components/ui/select';
import { cn } from '@client/lib/utils';

interface TimeRangeSelectProps {
  value: number;
  onValueChange: (value: number) => void;
  className?: string;
  triggerStyle?: CSSProperties;
}

const timeRanges = [
  { label: 'Last 7 days', value: 7 },
  { label: 'Last 14 days', value: 14 },
  { label: 'Last 30 days', value: 30 },
  { label: 'Last 90 days', value: 90 },
];

export function TimeRangeSelect({ value, onValueChange, className, triggerStyle }: TimeRangeSelectProps) {
  const selectedRange = timeRanges.find((r) => r.value === value) || timeRanges[2];

  return (
    <Select
      value={selectedRange.value.toString()}
      onValueChange={(v) => onValueChange(Number(v))}
      options={timeRanges.map((range) => ({
        label: range.label,
        value: range.value.toString(),
      }))}
      leadingIcon={<Clock className="h-3.5 w-3.5" />}
      triggerClassName={cn('h-8 w-44 text-xs', className)}
      triggerStyle={triggerStyle}
    />
  );
}
