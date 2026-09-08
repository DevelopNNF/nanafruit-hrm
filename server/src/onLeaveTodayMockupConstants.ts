// Shared between seedOnLeaveTodayMockup.ts and removeOnLeaveTodayMockup.ts —
// kept in its own module (rather than removeOnLeaveTodayMockup importing
// straight from seedOnLeaveTodayMockup) because that script's module body
// unconditionally kicks off its own main() as an import side effect; a
// script that only wants the constant would trigger a second seed run.
export const MOCKUP_OID = 'mockup:on-leave-today'
export const MOCKUP_NAME = 'Mockup Seed Script'
