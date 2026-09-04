// Letterhead data for a payslip. Hardcoded rather than a settings table: this is
// single-tenant software for one company, and an editable settings screen would be
// solving a problem nobody has yet — add a real table the day a second company
// needs one.

// taxId is still a PLACEHOLDER — fill in the company's real 13-digit tax ID
// before any slip generated from this leaves the dev environment.
export const COMPANY_INFO = {
  name: 'บริษัท นานาฟรุ้ต จำกัด',
  address: '99/99 หมู่ 1 ตำบลหนองควาย อำเภอหางดง จังหวัดเชียงใหม่ 50230',
  taxId: '0000000000000',
} as const
