import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import type { AttendanceIssue } from '../attendanceDailyQueries.js'
import {
  attendanceDigestHrEmail,
  attendanceDigestLineText,
  cancelledLineText,
  decisionLineText,
  hrPendingApprovalEmail,
  pendingApprovalLineText,
  resourceLabel,
} from './templates.js'

describe('resourceLabel', () => {
  it('has a Thai label for every request resource', () => {
    assert.equal(resourceLabel('leave_request'), 'คำขอลา')
    assert.equal(resourceLabel('overtime_request'), 'คำขอทำงานล่วงเวลา')
    assert.equal(resourceLabel('shift_change_request'), 'คำขอเปลี่ยนกะ')
    assert.equal(resourceLabel('day_off_swap_request'), 'คำขอสลับวันหยุด')
    assert.equal(resourceLabel('time_correction_request'), 'คำขอแก้ไขเวลา')
  })
})

describe('pendingApprovalLineText', () => {
  it('names the requester and the resource', () => {
    const text = pendingApprovalLineText('leave_request', 'สมชาย ใจดี')
    assert.match(text, /สมชาย ใจดี/)
    assert.match(text, /คำขอลา/)
  })
})

describe('decisionLineText', () => {
  it('approved carries no reason', () => {
    const text = decisionLineText('overtime_request', 'approved', 'unused')
    assert.match(text, /อนุมัติ/)
    assert.doesNotMatch(text, /unused/)
  })

  it('rejected includes the reason when given', () => {
    const text = decisionLineText('overtime_request', 'rejected', 'เอกสารไม่ครบ')
    assert.match(text, /ไม่ได้รับการอนุมัติ/)
    assert.match(text, /เอกสารไม่ครบ/)
  })

  it('rejected omits the reason line when null', () => {
    const text = decisionLineText('overtime_request', 'rejected', null)
    assert.doesNotMatch(text, /เหตุผล:/)
  })
})

describe('cancelledLineText', () => {
  it('names who cancelled and what', () => {
    const text = cancelledLineText('day_off_swap_request', 'สมหญิง มีสุข')
    assert.match(text, /สมหญิง มีสุข/)
    assert.match(text, /คำขอสลับวันหยุด/)
  })
})

describe('hrPendingApprovalEmail', () => {
  it('includes the requester name and request id in subject and body', () => {
    const { subject, bodyHtml } = hrPendingApprovalEmail('time_correction_request', 'สมชาย ใจดี', 42)
    assert.match(subject, /สมชาย ใจดี/)
    assert.match(bodyHtml, /42/)
    assert.match(bodyHtml, /คำขอแก้ไขเวลา/)
  })
})

const ABSENT_ISSUE: AttendanceIssue = {
  employeeId: 1,
  employeeName: 'สมชาย ใจดี',
  supervisorEmployeeId: 10,
  attendanceStatus: 'absent',
  lateMinutes: 0,
  earlyLeaveMinutes: 0,
}

const LATE_AND_EARLY_ISSUE: AttendanceIssue = {
  employeeId: 2,
  employeeName: 'สมหญิง มีสุข',
  supervisorEmployeeId: 10,
  attendanceStatus: 'present',
  lateMinutes: 15,
  earlyLeaveMinutes: 20,
}

describe('attendanceDigestLineText', () => {
  it('labels an absent day as ขาดงาน, with no minute counts', () => {
    const text = attendanceDigestLineText('2026-08-24', [ABSENT_ISSUE])
    assert.match(text, /สมชาย ใจดี: ขาดงาน/)
  })

  it('lists both late and early-leave minutes when a day has both', () => {
    const text = attendanceDigestLineText('2026-08-24', [LATE_AND_EARLY_ISSUE])
    assert.match(text, /สาย 15 นาที/)
    assert.match(text, /ออกก่อนเวลา 20 นาที/)
  })
})

describe('attendanceDigestHrEmail', () => {
  it('counts everyone in the subject and lists each one in the body', () => {
    const { subject, bodyHtml } = attendanceDigestHrEmail('2026-08-24', [ABSENT_ISSUE, LATE_AND_EARLY_ISSUE])
    assert.match(subject, /2 คน/)
    assert.match(bodyHtml, /สมชาย ใจดี/)
    assert.match(bodyHtml, /สมหญิง มีสุข/)
  })
})
