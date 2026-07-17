import './App.css'

// Shown when MSAL never got off the ground — almost always a missing or wrong
// value in admin/.env, since that is checked before anything else runs.
// Deliberately dependency-free: whatever broke, this still has to render.
function BootFailure({ message }: { message: string }) {
  return (
    <div className="auth-screen">
      <h1>เปิดระบบไม่สำเร็จ</h1>
      <div className="card error">
        <p className="headline">ตั้งค่าการเข้าสู่ระบบไม่ถูกต้อง</p>
        <p className="detail">{message}</p>
      </div>
      <p className="hint">กรุณาติดต่อฝ่าย IT</p>
    </div>
  )
}

export default BootFailure
