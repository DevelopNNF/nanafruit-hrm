import { alert, alertDetail, alertTitle } from './styles'

// Shown when MSAL never got off the ground — almost always a missing or wrong
// value in admin/.env, since that is checked before anything else runs.
// Deliberately dependency-free: whatever broke, this still has to render.
function BootFailure({ message }: { message: string }) {
  return (
    <div className="m-auto max-w-md p-8 text-center">
      <h1 className="mb-3">เปิดระบบไม่สำเร็จ</h1>
      <div className={`${alert('danger')} text-left`}>
        <p className={alertTitle('danger')}>ตั้งค่าการเข้าสู่ระบบไม่ถูกต้อง</p>
        <p className={alertDetail}>{message}</p>
      </div>
      <p className="mt-4 text-sm text-slate-500">กรุณาติดต่อฝ่าย IT</p>
    </div>
  )
}

export default BootFailure
