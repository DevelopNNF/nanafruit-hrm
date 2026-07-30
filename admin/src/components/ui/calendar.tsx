import * as React from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { DayPicker, getDefaultClassNames } from 'react-day-picker'

import { cn } from '../../lib/utils'

const WEEKDAYS_TH = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส']
const MONTHS_TH = [
  'มกราคม',
  'กุมภาพันธ์',
  'มีนาคม',
  'เมษายน',
  'พฤษภาคม',
  'มิถุนายน',
  'กรกฎาคม',
  'สิงหาคม',
  'กันยายน',
  'ตุลาคม',
  'พฤศจิกายน',
  'ธันวาคม',
]

type CalendarProps = React.ComponentProps<typeof DayPicker>

/** Thai labels via `formatters`, not a date-fns locale — keeps the same
 *  hardcoded THAI arrays DatePicker used before, with no new dependency. */
function Calendar({ className, classNames, showOutsideDays = true, ...props }: CalendarProps) {
  const defaultClassNames = getDefaultClassNames()

  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      captionLayout="dropdown"
      // 'around': prev/next chevrons sit either side of the dropdowns in one
      // row, instead of DayPicker's default of stacking Nav above the caption.
      navLayout="around"
      formatters={{
        formatWeekdayName: (date) => WEEKDAYS_TH[date.getDay()],
        formatMonthDropdown: (date) => MONTHS_TH[date.getMonth()],
      }}
      className={cn('p-0', className)}
      classNames={{
        root: cn(defaultClassNames.root, 'w-[17.5rem]'),
        months: cn(defaultClassNames.months, 'flex flex-col'),
        // The prev button, caption and next button are direct siblings (not
        // wrapped in a row) under navLayout="around" — flex-wrap plus
        // month_grid's basis-full below is what puts the grid on its own line.
        month: cn(defaultClassNames.month, 'flex flex-wrap items-center gap-x-1.5 gap-y-2'),
        month_caption: cn(defaultClassNames.month_caption, 'flex min-w-0 flex-1 items-center'),
        month_grid: cn(defaultClassNames.month_grid, 'w-full basis-full border-collapse'),
        dropdowns: cn(defaultClassNames.dropdowns, 'flex min-w-0 flex-1 items-center gap-1.5'),
        dropdown_root: cn(defaultClassNames.dropdown_root, 'relative min-w-0 flex-1'),
        dropdown: cn(
          defaultClassNames.dropdown,
          'absolute inset-0 appearance-none opacity-0',
        ),
        caption_label:
          'pointer-events-none flex min-w-0 flex-1 items-center justify-center rounded-md border border-slate-300 bg-white px-1.5 py-1 text-[0.8rem] text-slate-900',
        button_previous: cn(
          defaultClassNames.button_previous,
          'rounded-md p-1 text-slate-500 hover:bg-slate-100 disabled:pointer-events-none disabled:opacity-40',
        ),
        button_next: cn(
          defaultClassNames.button_next,
          'rounded-md p-1 text-slate-500 hover:bg-slate-100 disabled:pointer-events-none disabled:opacity-40',
        ),
        weekdays: cn(defaultClassNames.weekdays, 'flex'),
        weekday: cn(
          defaultClassNames.weekday,
          'w-9 flex-1 text-center text-[0.675rem] font-semibold text-slate-400',
        ),
        weeks: cn(defaultClassNames.weeks, 'flex flex-col gap-y-1'),
        week: cn(defaultClassNames.week, 'flex'),
        day: cn(defaultClassNames.day, 'w-9 flex-1 p-0 text-center'),
        day_button: cn(
          defaultClassNames.day_button,
          'aspect-square w-full rounded-md text-[0.8rem] tabular-nums text-slate-900 hover:enabled:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
        ),
        today: cn(defaultClassNames.today, '[&_[data-slot=calendar-day-button]]:border [&_[data-slot=calendar-day-button]]:border-navy [&_[data-slot=calendar-day-button]]:text-navy'),
        selected: cn(
          defaultClassNames.selected,
          '[&_[data-slot=calendar-day-button]]:bg-navy [&_[data-slot=calendar-day-button]]:text-white [&_[data-slot=calendar-day-button]]:hover:bg-navy',
        ),
        outside: cn(defaultClassNames.outside, 'text-slate-300'),
        disabled: cn(defaultClassNames.disabled, 'opacity-40'),
        hidden: cn(defaultClassNames.hidden, 'invisible'),
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation, ...chevronProps }) =>
          orientation === 'left' ? (
            <ChevronLeft className="size-4" {...chevronProps} />
          ) : (
            <ChevronRight className="size-4" {...chevronProps} />
          ),
        DayButton: ({ className: dayButtonClassName, ...dayButtonProps }) => (
          <button
            type="button"
            data-slot="calendar-day-button"
            className={dayButtonClassName}
            {...dayButtonProps}
          />
        ),
      }}
      {...props}
    />
  )
}

export { Calendar }
