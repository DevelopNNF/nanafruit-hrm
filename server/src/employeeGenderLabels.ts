// The employee import/export sheet shows gender in Thai, but employees.gender
// stores the GENDERS enum ('male'/'female'). One small shared table so the
// export and import parser can never drift apart on which Thai word means
// which enum value.

import type { Gender } from '@hrm/shared'

export const GENDER_LABELS: Record<Gender, string> = {
  male: 'ชาย',
  female: 'หญิง',
}

export function genderFromLabel(label: string): Gender | null {
  const entry = (Object.entries(GENDER_LABELS) as [Gender, string][]).find(
    ([, text]) => text === label
  )
  return entry ? entry[0] : null
}
