import * as React from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'

import { cn } from '../../lib/utils'

const Tabs = TabsPrimitive.Root

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        'mb-5 flex flex-wrap gap-1.5 rounded-lg border border-slate-200 bg-white p-1.5 shadow-sm',
        className,
      )}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        'rounded-md px-3 py-1.5 text-[0.825rem] font-medium text-slate-600 transition-colors hover:bg-slate-100 data-[state=active]:bg-navy data-[state=active]:text-white data-[state=active]:hover:bg-navy',
        className,
      )}
      {...props}
    />
  )
}

function TabsContent(props: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" {...props} />
}

export { Tabs, TabsContent, TabsList, TabsTrigger }
