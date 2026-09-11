import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { buildProductionTrackingFile } from './productionTrackingExport.js'

describe('buildProductionTrackingFile', () => {
  it('renames each employment type to Production Tracking’s own label', () => {
    const content = buildProductionTrackingFile([
      { employeeCode: 'EMP9996', firstNameTh: 'Employee', lastNameTh: 'Tester 1', employmentType: 'ประจำ (รายเดือน)', wageAmount: 18000 },
      { employeeCode: 'EMP9997', firstNameTh: 'Employee', lastNameTh: 'Tester 2', employmentType: 'ประจำ (รายวัน)', wageAmount: 450 },
      { employeeCode: 'EMP9998', firstNameTh: 'Employee', lastNameTh: 'Tester 3', employmentType: 'ชั่วคราว', wageAmount: 350 },
      { employeeCode: 'EMP9999', firstNameTh: 'Employee', lastNameTh: 'Tester 4', employmentType: 'สัญญาจ้าง', wageAmount: 10000 },
    ])

    assert.equal(
      content,
      [
        'EMP9996,Employee Tester 1,พนักงานรายเดือน,18000',
        'EMP9997,Employee Tester 2,พนักงานรายวันประจำ,450',
        'EMP9998,Employee Tester 3,พนักงานรายวันชั่วคราว,350',
        'EMP9999,Employee Tester 4,พนักงานชุดเหมา,10000',
      ].join('\n')
    )
  })

  it('writes 0 for an employee with no wage assignment yet, not a blank field', () => {
    const content = buildProductionTrackingFile([
      { employeeCode: 'EMP1', firstNameTh: 'ก', lastNameTh: 'ข', employmentType: 'ชั่วคราว', wageAmount: null },
    ])

    assert.equal(content, 'EMP1,ก ข,พนักงานรายวันชั่วคราว,0')
  })
})
